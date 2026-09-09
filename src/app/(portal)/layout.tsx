import { AuthGuard } from "@/components/layout/auth-guard"

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>
}
