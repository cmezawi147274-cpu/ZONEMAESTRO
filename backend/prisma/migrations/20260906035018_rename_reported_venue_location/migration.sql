-- Rename in place: these columns already hold real agent-reported data, so
-- they are renamed rather than dropped and recreated.

-- AlterTable
ALTER TABLE "MusicServer" RENAME COLUMN "timezone" TO "reportedTimezone";
ALTER TABLE "MusicServer" RENAME COLUMN "latitude" TO "reportedLatitude";
ALTER TABLE "MusicServer" RENAME COLUMN "longitude" TO "reportedLongitude";
ALTER TABLE "MusicServer" ADD COLUMN     "reportedLocationAt" TIMESTAMP(3);
