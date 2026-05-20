import { Prisma } from "@prisma/client";

export const QUEUE_NAME = "events";

export interface EventJob {
  eventType: string;
  payload: Prisma.InputJsonValue;
  tenantId: string;
  apikeyId: string;
  idempotencyKey?: string;
  receivedAt: string;
}
