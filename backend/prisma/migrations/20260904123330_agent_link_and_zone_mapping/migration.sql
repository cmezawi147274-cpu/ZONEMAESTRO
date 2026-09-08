-- AlterTable
ALTER TABLE "Zone" ADD COLUMN     "localZoneId" TEXT;

-- CreateTable
CREATE TABLE "AgentLink" (
    "id" TEXT NOT NULL,
    "cmmpServerId" TEXT NOT NULL,
    "agentServerGuid" TEXT NOT NULL,
    "siteId" TEXT,
    "pairedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "AgentLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentLink_cmmpServerId_key" ON "AgentLink"("cmmpServerId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentLink_agentServerGuid_key" ON "AgentLink"("agentServerGuid");

-- CreateIndex
CREATE INDEX "AgentLink_agentServerGuid_idx" ON "AgentLink"("agentServerGuid");

-- CreateIndex
CREATE UNIQUE INDEX "Zone_serverId_localZoneId_key" ON "Zone"("serverId", "localZoneId");

-- AddForeignKey
ALTER TABLE "AgentLink" ADD CONSTRAINT "AgentLink_cmmpServerId_fkey" FOREIGN KEY ("cmmpServerId") REFERENCES "MusicServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

