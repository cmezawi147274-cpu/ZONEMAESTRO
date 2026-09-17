"use client"

import { useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { KeyRound, Loader2 } from "lucide-react"
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
import { useSetUserPassword } from "@/hooks/use-users"
import { toast } from "sonner"
import type { User } from "@/lib/api/types"

const MIN_PASSWORD_LENGTH = 8
const schema = z.object({ newPassword: z.string().min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters`) })
type FormValues = z.infer<typeof schema>

/** A manager resetting a user in their scope — never their own account
 * (that's ChangePasswordCard, which requires the current password) and
 * never a peer or superior, enforced server-side regardless of what this
 * dialog is wired to show. No current password is asked for, matching
 * POST /users/:id/password's manager-reset path. */
export function ResetPasswordDialog({ user }: { user: User }) {
  const [open, setOpen] = useState(false)
  const setPassword = useSetUserPassword()
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { newPassword: "" } })

  async function onSubmit(values: FormValues) {
    try {
      await setPassword.mutateAsync({ id: user.id, newPassword: values.newPassword })
      toast.success(`Password reset for ${user.name}.`)
      form.reset({ newPassword: "" })
      setOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reset password")
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="icon-sm"><KeyRound className="size-3.5" /></Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset Password</DialogTitle>
          <DialogDescription>Set a new password for {user.name}. They will need it to sign in again — every current session is revoked.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="newPassword" render={({ field }) => (
              <FormItem>
                <FormLabel>New password</FormLabel>
                <FormControl><Input type="password" autoComplete="new-password" placeholder="At least 8 characters" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <DialogFooter>
              <Button type="submit" disabled={setPassword.isPending}>
                {setPassword.isPending && <Loader2 className="size-4 animate-spin" />}
                Reset Password
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
