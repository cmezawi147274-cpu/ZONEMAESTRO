-- AlterEnum
ALTER TYPE "CommandType" ADD VALUE 'SET_AUTO_BOOT';

-- AlterTable
ALTER TABLE "MusicServer" ADD COLUMN     "autoBootEnabled" BOOLEAN NOT NULL DEFAULT true;
