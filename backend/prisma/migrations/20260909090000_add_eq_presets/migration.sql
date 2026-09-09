-- CreateTable
CREATE TABLE "EqPreset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bands" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EqPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EqPreset_organizationId_idx" ON "EqPreset"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "EqPreset_organizationId_name_key" ON "EqPreset"("organizationId", "name");

-- AddForeignKey
ALTER TABLE "EqPreset" ADD CONSTRAINT "EqPreset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
