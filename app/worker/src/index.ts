import "dotenv/config";
import Redis from "ioredis";
import path from "node:path";
import dotenv from "dotenv";
import { Worker, QueueEvents, Queue } from "bullmq";
import { EventJob, QUEUE_NAME } from "@eventflow/shared";
import { processEvent } from "./processor";
import { prisma } from "@eventflow/db";

dotenv.config({
  path: path.resolve(process.cwd(), "../../.env"),
});

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  throw new Error("undefined REDIS_URL in env");
}

// nvr share blocking connections
const workerConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const eventConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const dlqConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

// DLQ is queue- all job land here after all retries exhausted
const dlqQueue = new Queue(QUEUE_NAME, { connection: dlqConnection });

const worker = new Worker<EventJob>(QUEUE_NAME, processEvent, {
  connection: workerConnection,
  concurrency: 5, //process 5 job simulatenouslu
});

// queueEvent- it uses SUBSCRIBE internally
const queueEvents = new QueueEvents(QUEUE_NAME, {
  connection: eventConnection,
});

// completed job
worker.on("completed", (job) => {
  console.log(`Job: ${job.id} completed!`);
});

// failed job
worker.on("failed", async (job, err) => {
  console.error(
    `[Job ${job?.id} failed after ${job?.attemptsMade} attempts]: `,
    err.message,
  );

  if (!job) return;

  prisma.event
    .update({
      where: { jobId: job.id },
      data: {
        status: "failed",
        lastError: err.message,
      },
    })
    .catch(console.error);

  // only move to dlq after all reteries exhausted
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade >= maxAttempts) {
    console.error(`[Job ${job.id}] moving to DLQ`);
     dlqQueue.add("dead-letter", {
      originalJob: job.data,
      failedReason: err.message,
      failedAt: new Date().toISOString(),
      attemptMade: job.attemptsMade,
    }).catch(console.error)
  }
});

// stalled job:

queueEvents.on("stalled", ({ jobId }) => {
  console.error(
    `[Job ${jobId} stalled- worker likely crashed mid-processing ]`,
  );
  // bullmq automatically re-queue stalled jobs
  // this event isjust for observability
});



// gracefull shutdown
process.on("SIGTERM",async()=>{
  console.error("SIGTERM received — shutting down worker gracefully");
  await worker.close()
  await queueEvents.close()
  await dlqQueue.close()
  process.exit(0)
})

