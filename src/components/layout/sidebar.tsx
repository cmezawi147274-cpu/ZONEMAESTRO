"use client"

import Link from "next/link"
import Image from "next/image"
import { usePathname } from "next/navigation"
import { NAV_GROUPS } from "@/components/layout/nav-items"
import { useAuth } from "@/hooks/use-auth"
import { cn } from "@/lib/utils"
import { LogoWordmark } from "@/components/common/logo"

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
      <div className="flex h-14 items-center gap-2.5 border-b px-4">
        {/* The real artwork's mark, cropped to just the icon (no baked-in
            wordmark) — see public/branding/zonemaestro-icon.jpg. */}
        <Image
          src="/branding/zonemaestro-icon.jpg"
          alt=""
          width={460}
          height={258}
          className="h-8 w-auto shrink-0 rounded-md"
        />
        <div className="leading-tight">
          <LogoWordmark className="text-sm" />
          <p className="text-[11px] text-muted-foreground">Precision Audio Orchestration</p>
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
