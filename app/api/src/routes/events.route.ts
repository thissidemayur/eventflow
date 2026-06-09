import { Router, Response, Request } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { validateEvent } from "../middleware/validate.js";
import  {eventQueue}  from "../config/queue.js";
import { apiKeyRateLimit } from "../middleware/apikeyRateLimit.js";
import { prisma } from "@eventflow/db";
import { ipRateLimit } from "../middleware/ipRateLimit.js";
import { createLogger, metrics } from "@eventflow/shared";

const router = Router();
const logger = createLogger("api:events");

router.get(
  "/events",
  ipRateLimit,
  authMiddleware,
  apiKeyRateLimit,
  async (req: Request, res: Response) => {
    try {
      const events = await prisma.event.findMany({
        where: { tenantId: req.tenantId! },
        orderBy: { receivedAt: "desc" },
        take: 50,
        select: {
          id: true,
          jobId: true,
          eventType: true,
          status: true,
          tenantId: true,
          attemptCount: true,
          processingDurationMs: true,
          receivedAt: true,
          processedAt: true,
          createdAt: true,
          lastError: true,
          idempotencyKey: true,
        },
      });

      return res.status(200).json(events);
    } catch (error: any) {
      logger.error(
        {
          error: error?.message,
          tenantId: req.tenantId,
        },
        "failed to fetch events",
      );
      return res.status(500).json({ error: "Failed to fetch events" });
    }
  },
);


router.get(
  "/events/:jobId",
  ipRateLimit,
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;

      const event = await prisma.event.findFirst({
        where: {
          jobId,
          tenantId: req.tenantId!, // always scope to caller's tenant
        },
        select: {
          id: true,
          jobId: true,
          eventType: true,
          status: true,
          tenantId: true,
          payload: true,
          attemptCount: true,
          processingDurationMs: true,
          receivedAt: true,
          processedAt: true,
          createdAt: true,
          lastError: true,
          idempotencyKey: true,
        },
      });

      if (!event) {
        // Return 404 for both "not found" and "wrong tenant"
        // Never confirm whether the resource exists to another tenant
        return res.status(404).json({ error: "Event not found" });
      }

      return res.status(200).json(event);
    } catch (error: any) {
      logger.error({error:error?.message , tenantId:req.tenantId, jobId:req.params.jobId},"failed to fetch event")
      return res.status(500).json({ error: "Failed to fetch event" });
    }
  },
);

router.post(
  "/events",
  ipRateLimit,
  authMiddleware,
  apiKeyRateLimit,
  validateEvent,
  async (req: Request, res: Response) => {
    const idempotencyKey = req.validatedEvent?.idempotencyKey;
    const tenantId = req.tenantId!;
    const eventType = req.validatedEvent?.type!;
    const payload = req.validatedEvent?.payload!;
    const receivedAtIso = new Date().toISOString();

    try {
      // STEP 1: BEFORE enqueueing, check if event with this idempotencyKey already exists
      if (idempotencyKey) {
        const existingEvent = await prisma.event.findUnique({
          where: { idempotencyKey },
          select: {
            jobId: true,
            tenantId: true,
          },
        });

        if (existingEvent && existingEvent.tenantId === tenantId) {
          logger.info({
            jobId: existingEvent.jobId,
            idempotencyKey,
            tenantId
          },"idempotent request- returning existing job")

          metrics.increment("events.duplicate")
          return res.status(202).json({
            accepted: false,
            jobId: existingEvent.jobId,
            duplicate: true,
          });
        }
      }


      const job = await eventQueue.add("process-event", {
        eventType: eventType,
        payload: payload,
        tenantId: tenantId,
        idempotencyKey: idempotencyKey,
        apikeyId: req.apiKeyId!,
        receivedAt: receivedAtIso,
      });
      metrics.increment("events.accepted")


      return res
        .status(202)
        .json({ accepted: true, jobId: job.id, duplicate: false });
        
    } catch (error: any) {
      // Handle race condition: if unique constraint fails, another request won the race
      if (
        error.code === "P2002" &&
        error.meta?.target?.includes("idempotency_key")
      ) {
       logger.warn({idempotencyKey,tenantId},"race condition detected- concurrent duplicate request")

        const existingEvent = await prisma.event.findUnique({
          where: { idempotencyKey },
        });

        if (existingEvent && existingEvent.tenantId === tenantId) {
         logger.info({jobId:existingEvent.jobId},"returing existing job from race condition winner")
          
          return res.status(202).json({
            accepted: false,
            jobId: existingEvent.jobId,
            duplicate: true,
          });
        }
      }

      logger.error({error: error.message,tenantId}, "failed to enqueue event");
      metrics.increment("events.enqueue_error")
      throw error;
    }
  },
);

export const eventRouter = router;
