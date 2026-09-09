-- AlterTable
ALTER TABLE "User" ADD COLUMN     "locationId" TEXT;

-- CreateIndex
CREATE INDEX "User_locationId_idx" ON "User"("locationId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
