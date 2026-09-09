"use client"

import { useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { Plus, Loader2, Copy, Check, ServerCog } from "lucide-react"
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useOrganizations } from "@/hooks/use-organizations"
import { useLocations } from "@/hooks/use-locations"
import { useRegisterServer, useSimulateAgentConnected } from "@/hooks/use-servers"
import { isMockMode } from "@/lib/config"
import type { MusicServer } from "@/lib/api/types"

const schema = z.object({
  organizationId: z.string().min(1, "Select an organization"),
  locationId: z.string().min(1, "Select a location"),
  name: z.string().min(2, "Name is required"),
})

type FormValues = z.infer<typeof schema>

export function RegisterServerDialog() {
  const [open, setOpen] = useState(false)
  const [registered, setRegistered] = useState<MusicServer | null>(null)
  const [copied, setCopied] = useState(false)
  const { data: organizations } = useOrganizations()
  const register = useRegisterServer()
  const simulateConnect = useSimulateAgentConnected()

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { organizationId: "", locationId: "", name: "" },
  })
  const organizationId = form.watch("organizationId")
  const { data: locations } = useLocations(organizationId || undefined)

  async function onSubmit(values: FormValues) {
    const server = await register.mutateAsync(values)
    setRegistered(server)
  }

  function reset() {
    form.reset()
    setRegistered(null)
    setCopied(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="size-4" /> Register Server
          </Button>
        }
      />
      <DialogContent>
        {!registered ? (
          <>
            <DialogHeader>
              <DialogTitle>Register a Windows MusicServer</DialogTitle>
              <DialogDescription>
                Create a server record and generate a pairing code for the on-site installer.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="organizationId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Organization</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={(v) => {
                          field.onChange(v)
                          form.setValue("locationId", "")
                        }}
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
                <FormField
                  control={form.control}
                  name="locationId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Location</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                        disabled={!organizationId}
                        items={Object.fromEntries((locations ?? []).map((loc) => [loc.id, loc.name]))}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder={organizationId ? "Select location" : "Select organization first"} />
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
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Server name</FormLabel>
                      <FormControl>
                        <Input placeholder="Downtown Bistro – MusicServer" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button type="submit" disabled={register.isPending}>
                    {register.isPending && <Loader2 className="size-4 animate-spin" />}
                    Generate Pairing Code
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Enter this code on the MusicServer installer</DialogTitle>
              <DialogDescription>
                On the Windows machine, open the MusicServer app and enter this pairing code to
                establish the outbound connection to the cloud. No inbound ports are required.
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-center justify-center gap-3 rounded-lg border bg-muted/40 p-6">
              <span className="font-mono text-3xl font-semibold tracking-widest">{registered.pairingCode}</span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  navigator.clipboard.writeText(registered.pairingCode ?? "")
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>

            {isMockMode && (
              <Alert>
                <ServerCog className="size-4" />
                <AlertTitle>Mock mode</AlertTitle>
                <AlertDescription>
                  There&apos;s no real Windows agent to pair with here — simulate it completing the
                  handshake so you can see the connected state.
                </AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              {isMockMode && (
                <Button
                  variant="outline"
                  disabled={simulateConnect.isPending}
                  onClick={async () => {
                    await simulateConnect.mutateAsync(registered.id)
                    setOpen(false)
                    reset()
                  }}
                >
                  {simulateConnect.isPending && <Loader2 className="size-4 animate-spin" />}
                  Simulate agent connecting
                </Button>
              )}
              <Button
                onClick={() => {
                  setOpen(false)
                  reset()
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
