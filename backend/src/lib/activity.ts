import { prisma } from "./db.js"
import { emitEvent, type RealtimeEvent } from "../realtime.js"

/** Records a fleet activity entry (src/lib/api/types.ts ActivityEvent) and
 * broadcasts the matching realtime event in one call — every route that
 * previously called emitEvent() directly for a user-visible action should
 * go through this instead so /monitoring/activity stays populated. */
export async function pushActivity(input: { type: RealtimeEvent["type"]; message: string; serverId?: string | null; zoneId?: string | null }) {
  await prisma.activityEvent.create({
    data: { type: input.type, message: input.message, serverId: input.serverId ?? null, zoneId: input.zoneId ?? null },
  })
  emitEvent({ type: input.type, serverId: input.serverId ?? null, zoneId: input.zoneId ?? null, data: { message: input.message } })
}
