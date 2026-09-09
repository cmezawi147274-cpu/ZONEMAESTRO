"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Music4 } from "lucide-react"
import { NAV_GROUPS } from "@/components/layout/nav-items"
import { useAuth } from "@/hooks/use-auth"
import { cn } from "@/lib/utils"

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const { can } = useAuth()

  // Groups whose every item is gated away are dropped entirely, so a
  // playback-only Viewer sees one heading, not a column of empty ones.
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.permission || can(item.permission)),
  })).filter((group) => group.items.length > 0)

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Music4 className="size-4" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold">CMMP</p>
          <p className="text-[11px] text-muted-foreground">Cloud Music Portal</p>
        </div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
                const link = (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                      active
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    {item.label}
                  </Link>
                )
                return link
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t p-3 text-[11px] text-muted-foreground">
        <p className="font-medium text-foreground/80">Windows MusicServer fleet</p>
        <p>The cloud manages. The MusicServer plays.</p>
      </div>
    </div>
  )
}
