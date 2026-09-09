"use client"

import { SidebarNav } from "@/components/layout/sidebar"
import { Topbar } from "@/components/layout/topbar"
import { usePrayerSchedulerBootstrap } from "@/hooks/use-prayer"

export function AppShell({ children }: { children: React.ReactNode }) {
  // Starts the single central Prayer Scheduler for the session — see
  // src/lib/prayer/scheduler.ts. Safe to call on every mount; it's a no-op
  // once already running.
  usePrayerSchedulerBootstrap()

  return (
    <div className="flex min-h-screen w-full">
      <aside className="hidden w-64 shrink-0 border-r lg:block">
        <div className="fixed h-screen w-64">
          <SidebarNav />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  )
}
