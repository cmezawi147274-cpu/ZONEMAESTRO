"use client"

import { useEffect, useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { UserPlus, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useInviteUser } from "@/hooks/use-users"
import { useOrganizations } from "@/hooks/use-organizations"
import { useLocations } from "@/hooks/use-locations"
import { useAuth } from "@/hooks/use-auth"
import { ROLES, ROLE_LABELS, type Role } from "@/lib/constants"

/** Roles bound to a single venue: a location is required, and its
 * organization — not a picker — decides the tenant. */
const LOCATION_BOUND: Role[] = ["VIEWER", "LOCATION_MANAGER"]

const schema = z
  .object({
    name: z.string().min(2, "Name is required"),
    email: z.string().email("Enter a valid email"),
    role: z.enum(ROLES),
    organizationId: z.string().nullable(),
    locationId: z.string().nullable(),
  })
  .refine((v) => !LOCATION_BOUND.includes(v.role) || !!v.locationId, {
    message: "Select a location",
    path: ["locationId"],
  })
  .refine((v) => v.role === "SUPER_ADMIN" || LOCATION_BOUND.includes(v.role) || !!v.organizationId, {
    message: "Select an organization",
    path: ["organizationId"],
  })

type FormValues = z.infer<typeof schema>

export function InviteUserDialog() {
  const [open, setOpen] = useState(false)
  const invite = useInviteUser()
  const { user, role: actorRole } = useAuth()

  // A Location Manager never chooses a tenant: theirs is the only one, and
  // the only venue they can staff is their own.
  const lockedOrganizationId = actorRole === "SUPER_ADMIN" ? null : user?.organizationId ?? null
  const lockedLocationId = actorRole === "LOCATION_MANAGER" ? user?.locationId ?? null : null

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      email: "",
      role: "VIEWER",
      organizationId: lockedOrganizationId,
      locationId: lockedLocationId,
    },
  })

  const role = form.watch("role")
  const organizationId = form.watch("organizationId")

  // Which roles this creator may mint: never a peer, never a superior.
  const assignableRoles = ROLES.filter((r) => {
    if (actorRole === "SUPER_ADMIN") return true
    if (actorRole === "ORGANIZATION_ADMIN") return r === "LOCATION_MANAGER" || r === "VIEWER"
    return r === "VIEWER"
  })

  const isLocationBound = LOCATION_BOUND.includes(role)
  // A Viewer is defined by its venue alone, so no organization is shown or
  // asked for — the location supplies it. Every other picker stays scoped to
  // the creator's own organization.
  const showOrganizationPicker = actorRole === "SUPER_ADMIN" && role !== "SUPER_ADMIN" && role !== "VIEWER"
  const locationOrganizationId =
    role === "VIEWER" ? lockedOrganizationId ?? undefined : organizationId ?? lockedOrganizationId ?? undefined

  const { data: organizations } = useOrganizations({ enabled: showOrganizationPicker })
  const { data: locations } = useLocations(locationOrganizationId ?? undefined, {
    enabled: isLocationBound && !lockedLocationId,
  })

  // Changing the role (or the organization above it) invalidates a location
  // picked under the previous scope.
  useEffect(() => {
    if (lockedLocationId) return
    form.setValue("locationId", null)
  }, [role, locationOrganizationId, lockedLocationId, form])

  async function onSubmit(values: FormValues) {
    await invite.mutateAsync({
      ...values,
      // The backend re-derives the organization from the location for
      // location-bound roles; send nothing that could contradict it.
      organizationId: values.role === "SUPER_ADMIN" || LOCATION_BOUND.includes(values.role) ? null : values.organizationId,
      locationId: values.role === "SUPER_ADMIN" ? null : values.locationId,
    })
    form.reset({
      name: "",
      email: "",
      role: "VIEWER",
      organizationId: lockedOrganizationId,
      locationId: lockedLocationId,
    })
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <UserPlus className="size-4" /> Invite User
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite User</DialogTitle>
          <DialogDescription>Grant portal access with a specific role and scope.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input type="email" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Role</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    items={Object.fromEntries(assignableRoles.map((r) => [r, ROLE_LABELS[r]]))}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {assignableRoles.map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {showOrganizationPicker && (
              <FormField
                control={form.control}
                name="organizationId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Organization</FormLabel>
                    <Select
                      value={field.value ?? ""}
                      onValueChange={field.onChange}
                      items={Object.fromEntries((organizations ?? []).map((org) => [org.id, org.name]))}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select organization" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {organizations?.map((org) => (
                          <SelectItem key={org.id} value={org.id}>
                            {org.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {isLocationBound && !lockedLocationId && (
              <FormField
                control={form.control}
                name="locationId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Location</FormLabel>
                    <Select
                      value={field.value ?? ""}
                      onValueChange={field.onChange}
                      items={Object.fromEntries((locations ?? []).map((loc) => [loc.id, loc.name]))}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select location" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {locations?.map((loc) => (
                          <SelectItem key={loc.id} value={loc.id}>
                            {loc.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <DialogFooter>
              <Button type="submit" disabled={invite.isPending}>
                {invite.isPending && <Loader2 className="size-4 animate-spin" />}
                Send Invite
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
