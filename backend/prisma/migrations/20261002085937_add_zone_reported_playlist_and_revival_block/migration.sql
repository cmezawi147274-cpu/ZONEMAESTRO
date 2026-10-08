-- AlterTable
ALTER TABLE "Zone" ADD COLUMN     "reportedPlaylistId" TEXT;

-- CreateTable
CREATE TABLE "ZoneRevivalBlock" (
    "serverId" TEXT NOT NULL,
    "localZoneId" TEXT NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "ZoneRevivalBlock_pkey" PRIMARY KEY ("serverId","localZoneId")
);

