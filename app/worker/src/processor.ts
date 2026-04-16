import { EventJob, createLogger } from "@eventflow/shared";
import { Job } from "bullmq";
import { prisma } from "@eventflow/db";
import { sendNotification } from "./notifications";
import { Prisma } from "@prisma/client";

const logger = createLogger("worker:processor")

export async function processEvent(job: Job<EventJob>) {
    const startTime = Date.now()
    const log = logger.child({jobId:job.id,tenantId:job.data.tenantId})
    log.info({eventType:job.data.eventType},"job started")
    
    const data = job.data

    try {
      const idempotencykey = data.idempotencyKey ?? `job-${job.id}`
      // write to DB as processing
      const event = await prisma.event.upsert({
        where: {
          idempotencyKey:idempotencykey,
        },
        create: {
          jobId: job.id!,
          idempotencyKey: data.idempotencyKey ?? `job-${job.id}`,
          tenantId: data.tenantId,
          eventType: data.eventType,
          payload: data.payload as Prisma.InputJsonValue,
          status: "processing",
          attemptCount: job.attemptsMade,
          receivedAt: new Date(data.receivedAt),
          processedAt: null,
          createdAt: new Date(),
        },
        update: {
          status: "processing",
          attemptCount: job.attemptsMade,
          lastError: null,
        },
      });
  
      // send notification- if notifications fails , we want bullmq to retry the whole job
      await sendNotification({
          eventType: data.eventType,
          tenantId:data.tenantId,
          payload: data.payload
      },idempotencykey!)
  
      // mark as completed with timing
      const durationMs = Date.now() - startTime
      await prisma.event.update({
          where:{id:event.id},
          data:{
              status:"completed",
              processedAt: new Date(),
              processingDurationMs: durationMs
          }
      })
          log.info({ durationMs }, "job completed");
  
    } catch (error:any) {
      log.error({
        error:error.message,
        attemptsMade:job.attemptsMade,
        stack:error.statck ?? undefined,
      },"job failed")
      throw error
    }


}