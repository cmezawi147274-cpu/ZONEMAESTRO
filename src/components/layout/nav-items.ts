import type { LucideIcon } from "lucide-react"
import {
  LayoutDashboard,
  Building2,
  MapPin,
  ServerCog,
  Speaker,
  Library,
  ListMusic,
  CalendarClock,
  RefreshCw,
  Activity,
  TerminalSquare,
  Users,
  Settings,
  Moon,
} from "lucide-react"
import type { Permission } from "@/lib/auth/rbac"

export interface NavItem {
  label: string
  href: string
  icon: LucideIcon
  permission?: Permission
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [{ label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, permission: "location:read" }],
  },
  {
    label: "Structure",
    items: [
      { label: "Organizations", href: "/organizations", icon: Building2, permission: "org:read" },
      { label: "Locations", href: "/locations", icon: MapPin, permission: "location:read" },
    ],
  },
  {
    label: "Fleet",
    items: [
      { label: "Music Servers", href: "/servers", icon: ServerCog, permission: "server:read" },
      { label: "Zones", href: "/zones", icon: Speaker, permission: "zone:read" },
    ],
  },
  {
    label: "Content",
    items: [
      { label: "Music Library", href: "/music", icon: Library, permission: "music:read" },
      { label: "Playlists", href: "/playlists", icon: ListMusic, permission: "playlist:read" },
      { label: "Scheduling", href: "/schedules", icon: CalendarClock, permission: "schedule:read" },
      { label: "Prayer Mode", href: "/prayer", icon: Moon, permission: "prayer:read" },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Synchronization", href: "/sync", icon: RefreshCw, permission: "sync:trigger" },
      { label: "Monitoring", href: "/monitoring", icon: Activity, permission: "logs:read" },
      { label: "Commands", href: "/commands", icon: TerminalSquare, permission: "server:command" },
    ],
  },
  {
    label: "Admin",
    items: [
      { label: "Users", href: "/users", icon: Users, permission: "users:manage" },
      { label: "Settings", href: "/settings", icon: Settings, permission: "location:read" },
    ],
  },
]

/**
 * The permission a portal route requires, by longest matching nav href. Used
 * by the route guard (src/components/layout/auth-guard.tsx) so a role that
 * cannot see a page in the sidebar cannot reach it by typing the URL either.
 */
export function requiredPermissionFor(pathname: string): Permission | undefined {
  let match: NavItem | undefined
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
        if (!match || item.href.length > match.href.length) match = item
      }
    }
  }
  return match?.permission
}
