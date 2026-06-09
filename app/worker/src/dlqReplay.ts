import { QUEUE_NAME, createLogger, metrics } from "@eventflow/shared";
import { Queue } from "bullmq";
import {Redis} from "ioredis";

const logger = createLogger("worker:dlqReplay")
const REDIS_URL = process.env.REDIS_URL!;

const dlqQueueConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const eventQueueConnection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

const eventQueue = new Queue(QUEUE_NAME, { connection: eventQueueConnection });
const dlqQueue = new Queue("events-dlq", {
  connection: dlqQueueConnection,
});

async function replayDLQ(batchSize = 10, delayBetweenMs = 2000) {
  let replayed = 0;
  while (true) {
    const jobs = await dlqQueue.getJobs(["waiting"], 0, batchSize - 1);
    if (jobs.length === 0) {
      logger.info({ totalReplayed: replayed },"DLQ replay completed");
      metrics.increment("dlq.replay_completed")
      break;
    }

    for (const job of jobs) {
      await eventQueue.add("process-event", job.data.originalJob, {
        delay: replayed * 50,
      });
      await job.remove();
      replayed++;
      logger.info({
        replayed,originalJob:job.id
      },"jo replayed")
      metrics.increment("dlq.job_replayed")
    }
    logger.info({ batchCompletedInMS: delayBetweenMs },"DLQ Batch completed");
    metrics.increment("dlq.batch_completed")
    await new Promise((r) => setTimeout(r, delayBetweenMs));
  }
}


replayDLQ(10,2000).catch(console.error)