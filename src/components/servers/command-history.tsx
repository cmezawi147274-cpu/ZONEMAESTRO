"use client"

import { EmptyState } from "@/components/common/empty-state"
import { CommandStatusBadge } from "@/components/common/status-badge"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TerminalSquare, ShieldCheck, Moon, User } from "lucide-react"
import { formatRelativeTime } from "@/lib/format"
import type { RemoteCommand } from "@/lib/api/types"
import type { CommandSource } from "@/lib/constants"

const SOURCE_CONFIG: Record<CommandSource, { label: string; icon: typeof User; className: string }> = {
  USER: { label: "User", icon: User, className: "text-muted-foreground" },
  SUPER_ADMIN: { label: "Super Admin", icon: ShieldCheck, className: "border-primary/30 bg-primary/10 text-primary" },
  SCHEDULE: {
    label: "Prayer Mode",
    icon: Moon,
    className: "border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
}

export function CommandHistory({ commands, isLoading, showServer }: { commands?: RemoteCommand[]; isLoading?: boolean; showServer?: (serverId: string) => string }) {
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading commands…</p>
  if (!commands || commands.length === 0) {
    return <EmptyState icon={TerminalSquare} title="No commands sent yet" className="border-none py-8" />
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Command</TableHead>
          {showServer && <TableHead>Server</TableHead>}
          <TableHead>Source</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Issued by</TableHead>
          <TableHead>Issued</TableHead>
          <TableHead>Result</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {commands.map((command) => {
          const source = SOURCE_CONFIG[command.source]
          const SourceIcon = source.icon
          return (
            <TableRow key={command.id}>
              <TableCell className="font-medium">{command.type.replaceAll("_", " ")}</TableCell>
              {showServer && <TableCell className="text-muted-foreground">{showServer(command.serverId)}</TableCell>}
              <TableCell>
                <Badge variant="outline" className={source.className}>
                  <SourceIcon className="size-3" /> {source.label}
                </Badge>
              </TableCell>
              <TableCell>
                <CommandStatusBadge status={command.status} />
              </TableCell>
              <TableCell className="text-muted-foreground">{command.issuedBy}</TableCell>
              <TableCell className="text-muted-foreground">{formatRelativeTime(command.issuedAt)}</TableCell>
              <TableCell className="max-w-56 truncate text-muted-foreground">{command.resultMessage ?? "—"}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
