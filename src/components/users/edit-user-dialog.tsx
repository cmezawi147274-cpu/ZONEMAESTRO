"use client"

import { useEffect, useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { Pencil, Loader2 } from "lucide-react"
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
import { useUpdateUser } from "@/hooks/use-users"
import { useOrganizations } from "@/hooks/use-organizations"
import { useLocations } from "@/hooks/use-locations"
import { ROLES, ROLE_LABELS, type Role } from "@/lib/constants"
import type { User } from "@/lib/api/types"

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

/** Edits an existing user's profile, role and scope. Mirrors
 * invite-user-dialog.tsx's role/org/location logic exactly — same
 * assignable-role and location-bound rules — but against PATCH /users/:id,
 * which the frontend already had wired to nothing (useUpdateUser existed,
 * this page never called it). */
export function EditUserDialog({ user, assignableRoles }: { user: User; assignableRoles: Role[] }) {
  const [open, setOpen] = useState(false)
  const update = useUpdateUser()

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: user.name, email: user.email, role: user.role, organizationId: user.organizationId, locationId: user.locationId },
  })

  useEffect(() => {
    if (open) form.reset({ name: user.name, email: user.email, role: user.role, organizationId: user.organizationId, locationId: user.locationId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user])

  const role = form.watch("role")
  const organizationId = form.watch("organizationId")
  const isLocationBound = LOCATION_BOUND.includes(role)
  const showOrganizationPicker = role !== "SUPER_ADMIN" && !LOCATION_BOUND.includes(role)
  const locationOrganizationId = role === "VIEWER" ? undefined : organizationId ?? undefined

  const { data: organizations } = useOrganizations({ enabled: showOrganizationPicker })
  const { data: locations } = useLocations(locationOrganizationId, { enabled: isLocationBound })

  async function onSubmit(values: FormValues) {
    await update.mutateAsync({
      id: user.id,
      name: values.name,
      email: values.email,
      role: values.role,
      organizationId: values.role === "SUPER_ADMIN" || LOCATION_BOUND.includes(values.role) ? null : values.organizationId,
      locationId: values.role === "SUPER_ADMIN" ? null : values.locationId,
    })
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="icon-sm"><Pencil className="size-3.5" /></Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit User</DialogTitle>
          <DialogDescription>Change {user.name}&apos;s profile, role or scope.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem><FormLabel>Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="email" render={({ field }) => (
              <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="role" render={({ field }) => (
              <FormItem>
                <FormLabel>Role</FormLabel>
                <Select value={field.value} onValueChange={field.onChange} items={Object.fromEntries(assignableRoles.map((r) => [r, ROLE_LABELS[r]]))}>
                  <FormControl><SelectTrigger className="w-full"><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent>
                    {assignableRoles.map((r) => <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>)}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            {showOrganizationPicker && (
              <FormField control={form.control} name="organizationId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Organization</FormLabel>
                  <Select value={field.value ?? ""} onValueChange={field.onChange} items={Object.fromEntries((organizations ?? []).map((o) => [o.id, o.name]))}>
                    <FormControl><SelectTrigger className="w-full"><SelectValue placeholder="Select organization" /></SelectTrigger></FormControl>
                    <SelectContent>{organizations?.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}</SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            )}
            {isLocationBound && (
              <FormField control={form.control} name="locationId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Location</FormLabel>
                  <Select value={field.value ?? ""} onValueChange={field.onChange} items={Object.fromEntries((locations ?? []).map((l) => [l.id, l.name]))}>
                    <FormControl><SelectTrigger className="w-full"><SelectValue placeholder="Select location" /></SelectTrigger></FormControl>
                    <SelectContent>{locations?.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}</SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            )}
            <DialogFooter>
              <Button type="submit" disabled={update.isPending}>
                {update.isPending && <Loader2 className="size-4 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
