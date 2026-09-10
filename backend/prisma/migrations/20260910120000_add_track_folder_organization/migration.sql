-- Tenant ownership for the music library.
--
-- Track and MusicFolder previously had no organization column at all, so
-- routes/music.ts could not filter by tenant even in principle: every
-- authenticated user of every organization could list, edit and delete
-- every other organization's tracks and folders.
--
-- Nullable on purpose, matching the Playlist.organizationId convention that
-- already existed. NULL means "the operator's shared catalogue": readable by
-- every organization, mutable only by a SUPER_ADMIN. Every row that exists
-- when this migration runs was uploaded by a SUPER_ADMIN whose own
-- organizationId is NULL, so there is no tenant to backfill them to and
-- leaving them NULL preserves exactly the visibility they have today.
-- Enforcement lives in backend/src/lib/tenant.ts.

-- AlterTable
ALTER TABLE "Track" ADD COLUMN "organizationId" TEXT;

-- AlterTable
ALTER TABLE "MusicFolder" ADD COLUMN "organizationId" TEXT;

-- CreateIndex
CREATE INDEX "Track_organizationId_idx" ON "Track"("organizationId");

-- CreateIndex
CREATE INDEX "MusicFolder_organizationId_idx" ON "MusicFolder"("organizationId");

-- AddForeignKey
ALTER TABLE "Track" ADD CONSTRAINT "Track_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MusicFolder" ADD CONSTRAINT "MusicFolder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
