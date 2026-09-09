"use client"

import { RefreshCw, Settings2, Power } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { RoleGate } from "@/components/common/role-gate"
import { useSendCommand } from "@/hooks/use-commands"
import { useSyncConfig } from "@/hooks/use-sync"
import type { MusicServer } from "@/lib/api/types"

export function ServerQuickActions({ server }: { server: MusicServer }) {
  const sendCommand = useSendCommand()
  const syncConfig = useSyncConfig()
  const disabled = server.status === "OFFLINE" || server.status === "UNKNOWN"

  return (
    <RoleGate anyOf={["server:command", "sync:trigger"]}>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => sendCommand.mutate({ serverId: server.id, type: "SYNC_MUSIC" })}
        >
          <RefreshCw className="size-4" /> Sync Music
        </Button>
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => syncConfig.mutate(server.id)}>
          <Settings2 className="size-4" /> Sync Configuration
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => sendCommand.mutate({ serverId: server.id, type: "RESTART_SERVICE" })}
        >
          <Power className="size-4" /> Restart Playback Service
        </Button>
        <label className="flex items-center gap-2 text-sm font-medium">
          <Switch
            checked={server.autoBootEnabled}
            disabled={disabled}
            onCheckedChange={(enabled) =>
              sendCommand.mutate({ serverId: server.id, type: "SET_AUTO_BOOT", payload: { enabled } })
            }
          />
          Auto boot
        </label>
      </div>
    </RoleGate>
  )
}
