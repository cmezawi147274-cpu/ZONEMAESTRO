"use client"

import Link from "next/link"
import { Menu, Bell, LogOut, User as UserIcon } from "lucide-react"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"
import { SidebarNav } from "@/components/layout/sidebar"
import { ConnectionPill } from "@/components/layout/connection-pill"
import { ThemeToggle } from "@/components/layout/theme-toggle"
import { useAuth } from "@/hooks/use-auth"
import { useAlerts } from "@/hooks/use-monitoring"
import { useRealtimeConnection } from "@/hooks/use-realtime"
import { ROLE_LABELS } from "@/lib/constants"
import { initials } from "@/lib/format"
import { useState } from "react"

export function Topbar() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const { user, logout, can } = useAuth()
  // The bell links into Monitoring and polls alerts every 10s; a role
  // without logs:read can reach neither, so it neither sees nor polls.
  const canReadAlerts = can("logs:read")
  const { data: alerts } = useAlerts({ enabled: canReadAlerts })
  const connectionState = useRealtimeConnection()
  const openAlertCount = alerts?.filter((a) => !a.acknowledged).length ?? 0

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarNav onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)}>
        <Menu className="size-5" />
      </Button>

      <div className="flex-1" />

      <ConnectionPill state={connectionState} />

      <ThemeToggle />

      {canReadAlerts && (
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          render={
            <Link href="/monitoring">
              <Bell className="size-4.5" />
              {openAlertCount > 0 && (
                <Badge className="absolute -right-0.5 -top-0.5 h-4 min-w-4 justify-center rounded-full px-1 text-[10px]">
                  {openAlertCount}
                </Badge>
              )}
            </Link>
          }
        />
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" className="gap-2 px-1.5">
              <Avatar className="size-7">
                <AvatarFallback className="text-xs">{user ? initials(user.name) : "?"}</AvatarFallback>
              </Avatar>
              <div className="hidden text-left leading-tight sm:block">
                <p className="text-sm font-medium">{user?.name}</p>
                <p className="text-[11px] text-muted-foreground">{user ? ROLE_LABELS[user.role] : ""}</p>
              </div>
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              <p className="font-medium">{user?.name}</p>
              <p className="text-xs font-normal text-muted-foreground">{user?.email}</p>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          {can("location:read") && (
            <>
              <DropdownMenuGroup>
                <DropdownMenuItem
                  render={
                    <Link href="/settings">
                      <UserIcon className="size-4" /> Profile
                    </Link>
                  }
                />
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuGroup>
            <DropdownMenuItem variant="destructive" onClick={() => logout()}>
              <LogOut className="size-4" /> Log out
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}
