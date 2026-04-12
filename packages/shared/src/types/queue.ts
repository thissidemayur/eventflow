
export const QUEUE_NAME = "events"

export interface EventJob {
    eventType: string;
    payload: Record<string,unknown>
    tenantId:string
    apikeyId: string
    idempotencyKey?: string
    receivedAt: string
}