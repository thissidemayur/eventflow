// import { Prisma } from "@prisma/client";

export const QUEUE_NAME = "events";

export interface EventJob {
  eventType: string;
  payload: Record<string, unknown>; //Prisma.InputJsonValue;
  tenantId: string;
  apikeyId: string;
  idempotencyKey?: string;
  receivedAt: string;
  correlationId: string;
}
