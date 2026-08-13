-- AlterTable
ALTER TABLE "track_record" ADD COLUMN     "closed_by_signal_id" UUID,
ADD COLUMN     "mark_price" DECIMAL(18,6);

-- AddForeignKey
ALTER TABLE "track_record" ADD CONSTRAINT "track_record_closed_by_signal_id_fkey" FOREIGN KEY ("closed_by_signal_id") REFERENCES "signals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
