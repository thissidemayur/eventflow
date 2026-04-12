import { EventJob, QUEUE_NAME } from "@eventflow/shared";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
export const connection = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null, // required by bullmq
});

export const eventQueue = new Queue<EventJob>(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts:3,
    backoff:{type:"exponential",delay:1000},
    removeOnComplete:100 ,// keep last 100 completed jobs for debugging
    removeOnFail:500 //keep last 500 jfailed jobs for inspection
  },
});
