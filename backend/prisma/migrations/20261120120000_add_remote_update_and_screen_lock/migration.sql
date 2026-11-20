-- AlterEnum
ALTER TYPE "CommandType" ADD VALUE 'UPDATE_SOFTWARE';
ALTER TYPE "CommandType" ADD VALUE 'UNLOCK_SCREEN';
ALTER TYPE "CommandType" ADD VALUE 'SET_LOCK_PASSWORD';

-- AlterTable
ALTER TABLE "MusicServer" ADD COLUMN     "agentHealth" JSONB,
ADD COLUMN     "agentHealthAt" TIMESTAMP(3),
ADD COLUMN     "agentUpdate" JSONB,
ADD COLUMN     "agentUpdateAt" TIMESTAMP(3);
