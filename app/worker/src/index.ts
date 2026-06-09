import { Worker, QueueEvents, Queue } from "bullmq";
import { EventJob, QUEUE_NAME, createLogger, metrics } from "@eventflow/shared";
import { processEvent } from "./processor.js";
import { prisma } from "@eventflow/db";
import Redis from "ioredis";

const logger = createLogger("worker:index");
const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  throw new Error("undefined REDIS_URL in env");
}

// nvr share blocking connections
const workerConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const eventConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const dlqConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

// DLQ is queue- all job land here after all retries exhausted
const dlqQueue = new Queue("events-dlq", {
  connection: dlqConnection,
});

const worker = new Worker<EventJob>(QUEUE_NAME, processEvent, {
  connection: workerConnection,
  concurrency: 5, //process 5 job simulatenouslu
});
logger.info({ concurrency: 5, queue: QUEUE_NAME }, "worker started");
metrics.gauge("worker.concurrency", 5);

// queueEvent- it uses SUBSCRIBE internally
const queueEvents = new QueueEvents(QUEUE_NAME, {
  connection: eventConnection,
});

// completed job
worker.on("completed", (_job) => {});

// failed job
worker.on("failed", async (job, err) => {
  if (!job) return;

  logger.error(
    {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      error: err.message,
    },
    "job permanently failed",
  );

  prisma.event
    .update({
      where: { jobId: job.id },
      data: {
        status: "failed",
        lastError: err.message,
      },
    })
    .catch((err: any) =>
      logger.error(
        { jobId: job.id, error: err.message },
        "failed to update event status",
      ),
    );

  // only move to dlq after all reteries exhausted
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade >= maxAttempts) {
    logger.warn(
      {
        jobId: job?.id,
      },
      "job moving to DLQ",
    );
    metrics.increment("dlq.jobs_added")
    await dlqQueue
      .add("dead-letter", {
        originalJob: job.data,
        failedReason: err.message,
        failedAt: new Date().toISOString(),
        attemptMade: job.attemptsMade,
      })

      .catch((err: any) => {
        logger.error(
          { jobId: job.id, error: err.message },
          "failed to sent job at DLQ",
        );
        metrics.increment("dlq.jobs_failed_to_add");
      });
  }
});

// stalled job:
queueEvents.on("stalled", ({ jobId }) => {
  logger.warn({ jobId }, "job stalled- worker likly crashed mid-processing");

  // bullmq automatically re-queue stalled jobs
  // this event isjust for observability
});

// gracefull shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received — shutting down worker gracefully");
  metrics.increment("worker.SIGTERM_recieved");
  await worker.close();
  await queueEvents.close();
  await dlqQueue.close();

  await workerConnection.quit();
  await eventConnection.quit();
  await dlqConnection.quit();

  await prisma.$disconnect();

  process.exitCode = 0;
  logger.info("worker and prisma shutdown complete");
  metrics.increment("worker.shutdown");
});
