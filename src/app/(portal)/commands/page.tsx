"use client"

import { useState } from "react"
import { PageHeader } from "@/components/common/page-header"
import { RoleGate } from "@/components/common/role-gate"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CommandHistory } from "@/components/servers/command-history"
import { SendCommandDialog } from "@/components/servers/send-command-dialog"
import { useCommands } from "@/hooks/use-commands"
import { useServers } from "@/hooks/use-servers"

export default function CommandsPage() {
  const [serverFilter, setServerFilter] = useState("all")
  const { data: servers } = useServers()
  const { data: commands, isLoading } = useCommands(serverFilter === "all" ? undefined : { serverId: serverFilter })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Remote Commands"
        description="Every command sent to a Windows MusicServer, with its asynchronous execution status. A command is never shown as successful until the server confirms it."
        actions={
          <RoleGate permission="server:command">
            <SendCommandDialog />
          </RoleGate>
        }
      />

      <Select
        value={serverFilter}
        onValueChange={(v) => setServerFilter(v ?? "all")}
        items={{ all: "All servers", ...Object.fromEntries((servers ?? []).map((s) => [s.id, s.name])) }}
      >
        <SelectTrigger className="w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All servers</SelectItem>
          {servers?.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Card>
        <CardContent>
          <CommandHistory
            commands={commands}
            isLoading={isLoading}
            showServer={(id) => servers?.find((s) => s.id === id)?.name ?? id}
          />
        </CardContent>
      </Card>
    </div>
  )
}
