-- AlterTable
ALTER TABLE "MusicServer" ADD COLUMN     "pairingConsumedAt" TIMESTAMP(3),
ADD COLUMN     "pairingConsumedCodeHash" TEXT,
ADD COLUMN     "pairingConsumedTokenPlain" TEXT,
ADD COLUMN     "pairingRevokedCodeHash" TEXT;

-- CreateTable
CREATE TABLE "DeletedServerTombstone" (
    "id" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeletedServerTombstone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MusicServer_pairingCodeHash_idx" ON "MusicServer"("pairingCodeHash");

-- CreateIndex
CREATE INDEX "MusicServer_pairingConsumedCodeHash_idx" ON "MusicServer"("pairingConsumedCodeHash");

-- CreateIndex
CREATE INDEX "MusicServer_pairingRevokedCodeHash_idx" ON "MusicServer"("pairingRevokedCodeHash");
