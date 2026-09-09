"use client"

import { useEffect, useState } from "react"
import { Moon, Sun, Monitor } from "lucide-react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

/**
 * QA review Option 1 (theme): next-themes was already a dependency and
 * globals.css already ships a full `.dark { … }` token set, but nothing
 * ever mounted a ThemeProvider or exposed a way to switch — dark mode was
 * dead code. See src/app/providers.tsx for the provider itself.
 *
 * `mounted` guards the icon shown before hydration: next-themes can't know
 * the resolved theme on the server (it depends on localStorage / the OS),
 * so rendering `resolvedTheme`'s icon pre-mount would either mismatch
 * hydration or flash. A static icon for one frame is preferable to either.
 */
export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const current = mounted ? (resolvedTheme ?? "light") : "light"
  const CurrentIcon = current === "dark" ? Moon : Sun

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Change theme" title="Change theme">
            <CurrentIcon className="size-4.5" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-36">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem key={value} onClick={() => setTheme(value)} className={theme === value ? "font-medium" : undefined}>
            <Icon className="size-4" /> {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
