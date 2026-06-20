import { Router, Response, Request } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { validateEvent } from "../middleware/validate.js";
import  {eventQueue}  from "../config/queue.js";
import { apiKeyRateLimit } from "../middleware/apikeyRateLimit.js";
import { prisma } from "@eventflow/db";
import { ipRateLimit } from "../middleware/ipRateLimit.js";
import { createLogger, metrics } from "@eventflow/shared";
import { redis } from "../config/redis.js";

const router = Router();
const logger = createLogger("api:events");
const EVENT_CACHE_TTL_SECONDS = 5;


/**
 * @openapi
 * /api/v1/events:
 *   get:
 *     summary: List events
 *     description: |
 *       Returns the latest 50 events for the caller's tenant, newest first.
 *       Served from a 5-second Redis cache — responses may be up to 5s stale.
 *       Tenant isolation is enforced: callers only see their own events.
 *     tags: [Events]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Array of events (max 50, newest first)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/EventSummary'
 *       401:
 *         description: Missing or invalid API key
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnauthorizedError'
 *       429:
 *         description: Rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RateLimitError'
 */
router.get(
  "/events",
  ipRateLimit,
  authMiddleware,
  apiKeyRateLimit,
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId
    const cacheKey = `events:list:${tenantId}`

    try {
      const cached = await redis.get(cacheKey)
      if(cached) {
        metrics.increment("events.list_cache_hit")
        return res.status(200).json(JSON.parse(cached))
      }

      metrics.increment("events.list_cache_miss")

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
          correlationId:true,
        },
      });

      // populate cache
      await redis.set(cacheKey,JSON.stringify(events),"EX",EVENT_CACHE_TTL_SECONDS)

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


/**
 * @openapi
 * /api/v1/events/{jobId}:
 *   get:
 *     summary: Get single event
 *     description: |
 *       Returns full detail of a single event including payload.
 *       Scoped to the caller's tenant — returns 404 for both "not found"
 *       and "belongs to another tenant" to prevent resource enumeration.
 *       Poll this endpoint every 2-3s while status is pending or processing.
 *     tags: [Events]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - name: jobId
 *         in: path
 *         required: true
 *         description: BullMQ job ID returned from POST /events
 *         schema:
 *           type: string
 *           example: "4"
 *     responses:
 *       200:
 *         description: Event detail with payload
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EventDetail'
 *       401:
 *         description: Missing or invalid API key
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnauthorizedError'
 *       404:
 *         description: Event not found (or belongs to another tenant)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Event not found
 */
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
          tenantId: req.tenantId!, 
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
          correlationId:true,
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


/**
 * @openapi
 * /api/v1/events:
 *   post:
 *     summary: Submit an event for async processing
 *     description: |
 *       Accepts an event, enqueues it via BullMQ, and returns immediately with a jobId.
 *       The API returns 202 in under 20ms regardless of processing time.
 *
 *       **Idempotency**: supply an `idempotencyKey` (UUID v4) to safely retry on
 *       network failure. Duplicate requests with the same key return the original
 *       jobId with `duplicate: true`.
 *
 *       **Correlation tracing**: include `x-request-id` in your request headers.
 *       This ID is stored on the event and appears in all worker logs,
 *       enabling end-to-end request tracing.
 *     tags: [Events]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - name: x-request-id
 *         in: header
 *         required: false
 *         description: Custom correlation ID for distributed tracing
 *         schema:
 *           type: string
 *           example: my-trace-id-001
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, payload]
 *             properties:
 *               type:
 *                 type: string
 *                 maxLength: 100
 *                 description: Event type identifier
 *                 example: user.signup
 *               payload:
 *                 type: object
 *                 description: Arbitrary event data. Must be a JSON object. Max 64KB.
 *                 example:
 *                   userId: u1
 *                   email: test@test.com
 *               idempotencyKey:
 *                 type: string
 *                 format: uuid
 *                 description: UUID v4 for exactly-once delivery semantics
 *                 example: f47ac10b-58cc-4372-a567-0e02b2c3d479
 *           examples:
 *             basic:
 *               summary: Basic event
 *               value:
 *                 type: user.signup
 *                 payload:
 *                   userId: u1
 *                   email: test@test.com
 *             with_idempotency:
 *               summary: With idempotency key (safe retry)
 *               value:
 *                 type: user.signup
 *                 payload:
 *                   userId: u1
 *                 idempotencyKey: f47ac10b-58cc-4372-a567-0e02b2c3d479
 *     responses:
 *       202:
 *         description: Event accepted (new or duplicate)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accepted:
 *                   type: boolean
 *                 jobId:
 *                   type: string
 *                   example: "6"
 *                 duplicate:
 *                   type: boolean
 *             examples:
 *               new_event:
 *                 summary: New event accepted
 *                 value:
 *                   accepted: true
 *                   jobId: "6"
 *                   duplicate: false
 *               duplicate:
 *                 summary: Duplicate request (idempotent replay)
 *                 value:
 *                   accepted: false
 *                   jobId: "4"
 *                   duplicate: true
 *       400:
 *         description: Validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationError'
 *       401:
 *         description: Missing or invalid API key
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnauthorizedError'
 *       429:
 *         description: Rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RateLimitError'
 *       503:
 *         description: Failed to enqueue event (queue unavailable)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Failed to accept event
 */
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
        correlationId:req.correlationId!
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
