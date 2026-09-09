"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { NAV_GROUPS } from "@/components/layout/nav-items"
import { useAuth } from "@/hooks/use-auth"

/**
 * QA review Option 7: `src/components/ui/command.tsx` (cmdk) already
 * existed, fully built, but nothing ever mounted it as a global palette —
 * it was only used inside two unrelated dialogs. Mounted once in
 * AppShell, opened with ⌘K / Ctrl+K from anywhere in the portal.
 *
 * Scope deliberately stays at page navigation only (the cheaper of the
 * two variants discussed): it does not search zone/server names or expose
 * contextual actions (Send Command, assign playlist, etc.) — those would
 * need their own capability + tenant-scope filtering per result, not just
 * per nav item, and weren't validated against a live UI this session.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const { can } = useAuth()

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])

  function go(href: string) {
    setOpen(false)
    router.push(href)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Go to…"
      description="Jump to any page you have access to"
    >
      <CommandInput placeholder="Jump to a page…" />
      <CommandList>
        <CommandEmpty>No matching page.</CommandEmpty>
        {NAV_GROUPS.map((group) => {
          // Filtered through the exact same can() the sidebar itself
          // gates on (src/lib/auth/rbac.ts) — a page a role can't see in
          // the sidebar must not become discoverable by typing its name
          // here instead (product rule 5: capability-based, not a second,
          // looser gate).
          const items = group.items.filter((item) => !item.permission || can(item.permission))
          if (items.length === 0) return null
          return (
            <CommandGroup key={group.label} heading={group.label}>
              {items.map((item) => {
                const Icon = item.icon
                return (
                  <CommandItem key={item.href} value={item.label} onSelect={() => go(item.href)}>
                    <Icon />
                    {item.label}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          )
        })}
      </CommandList>
    </CommandDialog>
  )
}
