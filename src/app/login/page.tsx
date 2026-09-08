"use client"

import { useState } from "react"
import Link from "next/link"
import Image from "next/image"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { Loader2, ShieldCheck, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useAuth } from "@/hooks/use-auth"
import { isMockMode } from "@/lib/config"
import { DEMO_CREDENTIALS, DEMO_PASSWORD } from "@/lib/mock/seed"

/** The real brand artwork, cropped to its content box — see
 * public/branding/zonemaestro-logo.jpg. Login-page only, per the ask;
 * everywhere else in the portal (the sidebar) still uses the hand-built
 * src/components/common/logo.tsx mark, which is what actually fits a
 * small icon slot on a light background. */
const LOGO_SRC = "/branding/zonemaestro-logo.jpg"
const LOGO_ALT = "ZoneMaestro — Precision Audio Orchestration"
const LOGO_W = 665
const LOGO_H = 490

/** Quiet capability signage, not marketing copy — this is an operate-mode
 * portal existing customers sign in to, not a page selling the product to
 * them. No icons, no descriptive sentences: just what's running. */
const CAPABILITIES = ["LIBRARY", "SCHEDULING", "MONITORING", "PRAYER MODE"]

const schema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
})

type FormValues = z.infer<typeof schema>

export default function LoginPage() {
  const { login, isLoggingIn, loginError } = useAuth()
  const [prefill, setPrefill] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: prefill ?? "", password: "" },
    values: prefill ? { email: prefill, password: DEMO_PASSWORD } : undefined,
  })

  async function onSubmit(values: FormValues) {
    try {
      await login(values)
    } catch {
      /* surfaced via loginError */
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.15fr_1fr]">
      {/* Brand hero — a fixed near-black panel regardless of the portal's
          own light/dark setting (deliberate: this is a control-room
          identity screen, not themed chrome — the rest of the app's
          tokens are untouched by this redesign). */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-neutral-950 p-10 text-white lg:flex xl:p-16">
        {/* Fine dot grid — the one texture on this panel, standing in for
            "schematic / control surface" rather than a soft marketing
            gradient. Pure atmosphere: aria-hidden, no layout impact. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage: "radial-gradient(rgba(255,255,255,0.09) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
            maskImage: "radial-gradient(ellipse 90% 70% at 30% 30%, black 40%, transparent 90%)",
          }}
        />

        <div className="relative motion-safe:animate-in motion-safe:fade-in motion-safe:duration-700">
          <Image
            src={LOGO_SRC}
            alt={LOGO_ALT}
            width={LOGO_W}
            height={LOGO_H}
            priority
            className="w-40 rounded-xl ring-1 ring-white/10 xl:w-44"
          />
        </div>

        <div className="relative space-y-10 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-700 motion-safe:delay-100 motion-safe:fill-mode-backwards">
          <div className="space-y-3">
            <p className="text-[11px] font-medium tracking-[0.28em] text-white/40">OPERATE</p>
            <h1 className="text-3xl leading-[1.15] font-medium tracking-tight text-white xl:text-4xl">
              One signal.
              <br />
              Every zone.
            </h1>
            <p className="max-w-sm text-sm leading-relaxed text-white/50">
              Sign in to manage playback, playlists and schedules across every connected Music
              Server — online or off.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/10 pt-5">
            {CAPABILITIES.map((c) => (
              <span key={c} className="text-[10px] font-medium tracking-[0.18em] text-white/35">
                {c}
              </span>
            ))}
          </div>
        </div>

        <p className="relative text-[11px] text-white/25">© {new Date().getFullYear()} ZoneMaestro</p>
      </div>

      <div className="flex items-center justify-center bg-background p-6 sm:p-10">
        <div className="w-full max-w-sm space-y-6 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-500">
          <div className="space-y-1.5 text-center lg:text-left">
            <div className="mb-6 flex justify-center lg:hidden">
              <Image
                src={LOGO_SRC}
                alt={LOGO_ALT}
                width={LOGO_W}
                height={LOGO_H}
                priority
                className="w-36 rounded-lg ring-1 ring-black/5 dark:ring-white/10"
              />
            </div>
            <h2 className="text-xl font-medium tracking-tight">Welcome back</h2>
            <p className="text-sm text-muted-foreground">Sign in to your ZoneMaestro portal.</p>
          </div>

          <div className="rounded-lg border bg-card p-6">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                {loginError && (
                  <Alert variant="destructive">
                    <AlertDescription>{loginError.message}</AlertDescription>
                  </Alert>
                )}
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input placeholder="you@company.com" autoComplete="email" autoFocus {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input
                            type={showPassword ? "text" : "password"}
                            autoComplete="current-password"
                            className="pr-9"
                            {...field}
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword((v) => !v)}
                            aria-label={showPassword ? "Hide password" : "Show password"}
                            aria-pressed={showPassword}
                            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
                          >
                            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                          </button>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" className="w-full" disabled={isLoggingIn}>
                  {isLoggingIn && <Loader2 className="size-4 animate-spin" />}
                  Sign in
                </Button>
              </form>
            </Form>
          </div>

          <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            Encrypted session · Music Servers pair outbound-only, no open ports
          </div>

          {isMockMode && (
            <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
              <p className="text-xs font-medium text-muted-foreground">
                Mock mode demo accounts — password: <code className="font-mono">{DEMO_PASSWORD}</code>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {DEMO_CREDENTIALS.map((cred) => (
                  <button
                    key={cred.email}
                    type="button"
                    onClick={() => setPrefill(cred.email)}
                    className="rounded-md border bg-background px-2 py-1 text-xs font-medium hover:bg-muted"
                  >
                    {cred.role.replace("_", " ")}
                  </button>
                ))}
              </div>
            </div>
          )}

          <p className="text-center text-xs text-muted-foreground">
            Windows MusicServer administrator?{" "}
            <Link href="/servers" className="font-medium underline underline-offset-2">
              Manage server pairing
            </Link>{" "}
            after signing in.
          </p>
        </div>
      </div>
    </div>
  )
}
