-- CreateTable
CREATE TABLE "ServerPrayerOverride" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "prayers" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerPrayerOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServerPrayerOverride_serverId_key" ON "ServerPrayerOverride"("serverId");

-- AddForeignKey
ALTER TABLE "ServerPrayerOverride" ADD CONSTRAINT "ServerPrayerOverride_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "MusicServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
