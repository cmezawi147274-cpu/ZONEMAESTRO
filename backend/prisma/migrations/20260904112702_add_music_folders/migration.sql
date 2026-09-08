-- AlterTable
ALTER TABLE "Track" ADD COLUMN     "folderId" TEXT;

-- CreateTable
CREATE TABLE "MusicFolder" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MusicFolder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Track_folderId_idx" ON "Track"("folderId");

-- AddForeignKey
ALTER TABLE "Track" ADD CONSTRAINT "Track_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "MusicFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
