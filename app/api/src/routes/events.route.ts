import { Router, Response, Request } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { validateEvent } from "../middleware/validate.js";
import { eventQueue } from "../config/queue.js";
import { apiKeyRateLimit } from "../middleware/apikeyRateLimit.js";
import { prisma } from "@eventflow/db";
import { ipRateLimit } from "../middleware/ipRateLimit.js";

const router = Router()

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
      console.error("Failed to fetch events:", error.message);
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
      console.error("Failed to fetch event:", error.message);
      return res.status(500).json({ error: "Failed to fetch event" });
    }
  },
);


router.post("/events",ipRateLimit, authMiddleware, apiKeyRateLimit, validateEvent, async (req: Request, res: Response) => {
    const idempotencyKey = req.validatedEvent?.idempotencyKey;
    const tenantId = req.tenantId!;
    const eventType = req.validatedEvent?.type!;
    const payload = req.validatedEvent?.payload!;
    const receivedAtIso = new Date().toISOString();

    try {
        // STEP 1: BEFORE enqueueing, check if event with this idempotencyKey already exists
        if (idempotencyKey) {
            console.log(`Checking for existing event with idempotencyKey: ${idempotencyKey}`);
            
            const existingEvent = await prisma.event.findUnique({
                where: { idempotencyKey },
            });

            if (existingEvent) {
                // Verify tenant match to prevent cross-tenant access
                if (existingEvent.tenantId === tenantId) {
                    console.log(` IDEMPOTENT: Found existing event. Returning jobId: ${existingEvent.jobId}`);
                    return res.status(202).json({ 
                        accepted: false, 
                        jobId: existingEvent.jobId, 
                        duplicate: true 
                    });
                }
            }
        }

        // STEP 2: No existing event found, proceed to enqueue
        console.log(`Creating new event with idempotencyKey: ${idempotencyKey}`);
        
        const job = await eventQueue.add("process-event", {
            eventType: eventType,
            payload: payload,
            tenantId: tenantId,
            idempotencyKey: idempotencyKey,
            apikeyId: req.apiKeyId!,
            receivedAt: receivedAtIso
        });

        console.log(`Job enqueued. jobId: ${job.id}`);

        // STEP 3: Store event in database
         await prisma.event.create({
            data: {
                jobId: job.id!,
                idempotencyKey: idempotencyKey || undefined,
                tenantId: tenantId,
                eventType: eventType,
                payload: payload,
                status: "pending",
                receivedAt: new Date(receivedAtIso),
                createdAt: new Date(),
            }
        });

        console.log(` Event stored in DB with jobId: ${job.id}`);

      return res.status(202).json({ accepted: true, jobId: job.id, duplicate: false });

    } catch (error: any) {
        // Handle race condition: if unique constraint fails, another request won the race
        if (error.code === "P2002" && error.meta?.target?.includes("idempotency_key")) {
            console.log(` RACE CONDITION: idempotencyKey already in DB (another request won). Fetching...`);
            
            const existingEvent = await prisma.event.findUnique({
                where: { idempotencyKey },
            });

            if (existingEvent && existingEvent.tenantId === tenantId) {
                console.log(` Returning existing jobId from winner: ${existingEvent.jobId}`);
                return res.status(202).json({
                  accepted: false,
                  jobId: existingEvent.jobId,
                  duplicate: true,
                });
            }
        }

        console.error("Error processing event:", error);
        throw error;
    }
})

export const eventRouter = router