-- Security audit trail.
--
-- ActivityEvent already existed but is an operational dashboard feed: no
-- actor, no IP, no before/after. "Which of our staff deleted this playlist?"
-- had no answer, which fails B2B procurement and leaves an incident with
-- nothing to investigate.
--
-- Deliberately carries NO foreign keys: an audit entry has to survive the
-- deletion of both the actor and the target, which is precisely when it
-- matters most. Actor identity is denormalised for the same reason.

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorEmail" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "organizationId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "summary" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_at_idx" ON "AuditLog"("organizationId", "at");
CREATE INDEX "AuditLog_actorId_at_idx" ON "AuditLog"("actorId", "at");
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");
