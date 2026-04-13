-- CreateTable
CREATE TABLE "notification_log" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_log_idempotency_key_key" ON "notification_log"("idempotency_key");
