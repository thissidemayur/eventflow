-- AlterTable
ALTER TABLE "events" ADD COLUMN     "correlation_id" TEXT;

-- CreateIndex
CREATE INDEX "events_correlation_id_idx" ON "events"("correlation_id");
