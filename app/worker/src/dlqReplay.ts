import { QUEUE_NAME } from "@eventflow/shared";
import { Queue } from "bullmq";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL!;
const dlqQueueConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const eventQueueConnection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

const eventQueue = new Queue(QUEUE_NAME, { connection: eventQueueConnection });
const dlqQueue = new Queue("events-dlq", { connection: dlqQueueConnection });

async function replayDLQ(batchSize = 10, delayBetweenMs = 2000) {
  let replayed = 0;
  while (true) {
    const jobs = await dlqQueue.getJobs(["waiting"], 0, batchSize - 1);
    if (jobs.length === 0) {
      console.log(`DLQ replay complete. Total replayed: ${replayed}`);
      break;
    }

    for (const job of jobs) {
      await eventQueue.add("process-event", job.data.originalJob, {
        delay: replayed * 50,
      });
      await job.remove();
      replayed++;
      console.log(`Replayed job ${replayed}: ${job.id}`);
    }
    console.log(`Batch done. Waiting ${delayBetweenMs}ms before next batch...`);
    await new Promise((r) => setTimeout(r, delayBetweenMs));
  }
}


replayDLQ(10,2000).catch(console.error)