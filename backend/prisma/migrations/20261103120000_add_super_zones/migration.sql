-- AlterTable
ALTER TABLE "Zone" ADD COLUMN     "leaderZoneId" TEXT,
ADD COLUMN     "superZoneCopyVolume" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Zone_leaderZoneId_idx" ON "Zone"("leaderZoneId");

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_leaderZoneId_fkey" FOREIGN KEY ("leaderZoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
