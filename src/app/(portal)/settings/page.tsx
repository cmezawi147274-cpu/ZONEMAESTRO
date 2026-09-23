"use client"

import { useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { Download, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/common/page-header"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { useAuth } from "@/hooks/use-auth"
import { readSession } from "@/lib/auth/session"
import { useSetUserPassword } from "@/hooks/use-users"
import { useOrganization } from "@/hooks/use-organizations"
import { isMockMode, env } from "@/lib/config"
import { ROLE_LABELS } from "@/lib/constants"
import { formatDateTime, initials } from "@/lib/format"

const MIN_PASSWORD_LENGTH = 8
const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, "Required"),
    newPassword: z.string().min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters`),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { message: "Passwords don't match", path: ["confirmPassword"] })
type PasswordFormValues = z.infer<typeof passwordSchema>

/** Self-service password change. Requires the current password (unlike a
 * manager's reset of someone else) and, since the backend revokes every
 * live refresh token for the target on either path — including this
 * session's own — logs out and sends the user back to sign in with the
 * new password rather than leaving a session that will fail its next
 * silent refresh with no explanation. */
function ChangePasswordCard() {
  const { user, logout } = useAuth()
  const setPassword = useSetUserPassword()
  const [done, setDone] = useState(false)
  const form = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  })

  async function onSubmit(values: PasswordFormValues) {
    try {
      if (!user) throw new Error("Not signed in")
      await setPassword.mutateAsync({ id: user.id, currentPassword: values.currentPassword, newPassword: values.newPassword })
      setDone(true)
      toast.success("Password changed. Please sign in again.")
      await logout()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change password")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Change Password</CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="currentPassword" render={({ field }) => (
              <FormItem>
                <FormLabel>Current password</FormLabel>
                <FormControl><Input type="password" autoComplete="current-password" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="newPassword" render={({ field }) => (
              <FormItem>
                <FormLabel>New password</FormLabel>
                <FormControl><Input type="password" autoComplete="new-password" placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`} {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="confirmPassword" render={({ field }) => (
              <FormItem>
                <FormLabel>Confirm new password</FormLabel>
                <FormControl><Input type="password" autoComplete="new-password" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <Button type="submit" disabled={setPassword.isPending || done}>
              {setPassword.isPending && <Loader2 className="size-4 animate-spin" />}
              Change Password
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}

/** Super-Admin-only download of the Local Music Server installer.
 *
 * Fetched rather than linked: the portal authenticates with a bearer token
 * from localStorage (src/lib/auth/session.ts), which a plain <a href="">
 * cannot send — so the file is requested with the header and handed to the
 * browser as a blob. The endpoint enforces the same Super Admin check
 * server-side, so hiding this card is UX only. */
function LocalMusicServerCard() {
  const [downloading, setDownloading] = useState(false)

  async function download() {
    setDownloading(true)
    try {
      const session = readSession()
      const res = await fetch(`${env.apiUrl}/downloads/local-music-server`, {
        headers: session ? { Authorization: `Bearer ${session.tokens.accessToken}` } : {},
      })
      if (!res.ok) {
        throw new Error(res.status === 404 ? "No installer has been uploaded yet." : "Could not download the installer")
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      // Named explicitly: a blob: URL carries no filename, so an empty
      // download attribute makes the browser save it as the blob's UUID.
      link.download = "local-music-server.zip"
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not download the installer")
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Local Music Server</CardTitle>
        <CardDescription>The installer for setting up a venue PC.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={download} disabled={downloading}>
          {downloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          Download Latest Local Music Server
        </Button>
      </CardContent>
    </Card>
  )
}

export default function SettingsPage() {
  const { user } = useAuth()
  const { data: org } = useOrganization(user?.organizationId ?? undefined)

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Settings" description="Your profile and portal configuration." />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Profile</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <Avatar className="size-14">
            <AvatarFallback>{user ? initials(user.name) : "?"}</AvatarFallback>
          </Avatar>
          <div className="space-y-1">
            <p className="font-medium">{user?.name}</p>
            <p className="text-sm text-muted-foreground">{user?.email}</p>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{user ? ROLE_LABELS[user.role] : ""}</Badge>
              {org && <Badge variant="outline">{org.name}</Badge>}
            </div>
          </div>
        </CardContent>
      </Card>

      <ChangePasswordCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Member since</span>
            <span>{user ? formatDateTime(user.createdAt) : "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Last login</span>
            <span>{user?.lastLoginAt ? formatDateTime(user.lastLoginAt) : "—"}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Portal Configuration</CardTitle>
          <CardDescription>Read-only — configured via environment variables at deployment time.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">API mode</span>
            <Badge variant={isMockMode ? "secondary" : "outline"}>{isMockMode ? "Mock" : "Live"}</Badge>
          </div>
          {!isMockMode && (
            <>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">API URL</span>
                <span className="font-mono text-xs">{env.apiUrl}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Realtime URL</span>
                <span className="font-mono text-xs">{env.wsUrl}</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {user?.role === "SUPER_ADMIN" && <LocalMusicServerCard />}
    </div>
  )
}
