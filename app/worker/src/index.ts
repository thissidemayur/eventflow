import "dotenv/config";
import Redis from "ioredis";
import path from "node:path";
import dotenv from "dotenv";
import { Worker,QueueEvents } from "bullmq";
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

const connection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

const queueEvents = new QueueEvents(QUEUE_NAME, { connection });


const worker = new Worker<EventJob>(QUEUE_NAME, processEvent, {
  connection,
  concurrency: 5, //process 5 job simulatenouslu
});

// completed job
worker.on("completed",(job)=>{
    console.log(`Job: ${job.id} completed!`)
})

// failed job
worker.on("failed",(job,err)=>{
  console.error(
    `[Job ${job?.id} failed after ${job?.attemptsMade} attempts]: `,
    err.message,
  );

  if(job) {
    prisma.event.update({
      where:{jobId:job.id},
      data:{
        status:"failed",lastError:err.message
      }
    }).catch(console.error)
  }
})


// stalled job:

queueEvents.on("stalled",({jobId})=>{
  console.error(`[Job ${jobId} stalled- worker likely crashed mid-processing ]`)
  // bullmq automatically re-queue stalled jobs
  // this event isjust for observability
})