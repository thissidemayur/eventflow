-- CreateEnum
CREATE TYPE "EvenStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "tenant_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "EvenStatus" NOT NULL,
    "error_message" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL,
    "processed_at" TIMESTAMP(3),
    "processing_duration_ms" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "events_job_id_key" ON "events"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "events_idempotency_key_key" ON "events"("idempotency_key");

-- CreateIndex
CREATE INDEX "events_tenant_id_idx" ON "events"("tenant_id");

-- CreateIndex
CREATE INDEX "events_status_idx" ON "events"("status");

-- CreateIndex
CREATE INDEX "events_event_type_idx" ON "events"("event_type");

-- CreateIndex
CREATE INDEX "events_received_at_idx" ON "events"("received_at");

-- CreateIndex
CREATE INDEX "events_idempotency_key_idx" ON "events"("idempotency_key");
