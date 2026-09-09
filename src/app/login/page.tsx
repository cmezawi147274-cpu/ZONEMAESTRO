"use client"

import { useState } from "react"
import Image from "next/image"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { Loader2, Mail, Lock, Eye, EyeOff, ArrowRight } from "lucide-react"
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
import { safeRedirectTarget } from "@/lib/auth/rbac"
import { isMockMode } from "@/lib/config"
import { DEMO_CREDENTIALS, DEMO_PASSWORD } from "@/lib/mock/seed"
import { cn } from "@/lib/utils"
import { LoginHero } from "@/app/login/login-hero"

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
      // QA review Option 4: src/proxy.ts sets `?from=<pathname>` when it
      // redirects a signed-out deep link to /login, but nothing ever read
      // it back — a operator following a shared link always landed on
      // their role's generic default page instead. Read directly off
      // window.location rather than next/navigation's useSearchParams()
      // so this stays a plain client-side read at submit time, with no
      // Suspense-boundary requirement on the page. safeRedirectTarget
      // rejects anything but an in-app relative path, so a crafted `from`
      // can't turn this into an open redirect.
      const from = typeof window !== "undefined" ? safeRedirectTarget(new URLSearchParams(window.location.search).get("from")) : null
      await login(values, from ?? undefined)
    } catch {
      /* surfaced via loginError */
    }
  }

  return (
    // Scoped font, not a globals.css change: html{font-family:var(--font-sans)}
    // resolves to nothing app-wide — `--font-sans` in the @theme inline block
    // (globals.css) is circularly self-referenced with no real value defined
    // anywhere, so every page silently falls back to the browser's default
    // serif. Pre-existing, not introduced by this work — out of scope to fix
    // globally here (would touch shared theme config). This screen names its
    // face directly: `--font-logo` (Montserrat, set on <html> by next/font in
    // layout.tsx) is what the design reference typesets the whole login in.
    <div
      className="grid min-h-screen bg-[#111111] text-white lg:grid-cols-[7fr_3fr]"
      style={{ fontFamily: "var(--font-logo), ui-sans-serif, system-ui, sans-serif" }}
    >
      <LoginHero />

      {/* `dark` scopes shadcn's dark token set to this panel (Alert,
          FormMessage) — otherwise Alert's destructive variant reads the
          app's light :root tokens and renders a white box. */}
      <section className="dark flex min-h-screen items-center justify-center bg-[#111111] px-6 py-12 sm:px-10">
        <div className="login-form-enter w-full max-w-sm">
          <div className="mb-10 lg:hidden">
            <Image
              src="/branding/login-mark-trimmed.png"
              alt="ZoneMaestro — Precision Audio Orchestration"
              width={467}
              height={425}
              priority
              draggable={false}
              className="h-auto w-[150px] max-w-full select-none"
              style={{
                mixBlendMode: "screen",
                filter: "contrast(1.25) drop-shadow(0 8px 22px rgba(0, 0, 0, 0.5))",
              }}
            />
          </div>

          <h2 className="text-[1.9rem] leading-tight font-bold text-white">Sign in</h2>
          <p className="mt-1.5 text-[14px] text-gray-400">Group operators and venue administrators.</p>

          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className={cn("mt-7 space-y-5", loginError && "login-error-shake")}
            >
              {loginError && (
                <Alert variant="destructive" className="border-red-500/30 bg-red-500/10">
                  <AlertDescription className="text-[13px] text-red-300">{loginError.message}</AlertDescription>
                </Alert>
              )}

              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem className="space-y-2">
                    <FormLabel className="text-[13px] font-medium text-gray-400">Email</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Mail className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-gray-500" />
                        <Input
                          placeholder="ops@group.example"
                          autoComplete="email"
                          autoFocus
                          className="h-11 rounded-md border-[#262626] bg-[#181818] pl-10 text-[15px] text-white placeholder:text-gray-600 focus-visible:border-[#34b4f5] focus-visible:ring-[#34b4f5]/30"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem className="space-y-2">
                    <FormLabel className="text-[13px] font-medium text-gray-400">Password</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Lock className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-gray-500" />
                        <Input
                          type={showPassword ? "text" : "password"}
                          autoComplete="current-password"
                          placeholder="••••••••••"
                          className="h-11 rounded-md border-[#262626] bg-[#181818] pr-11 pl-10 text-[15px] text-white placeholder:text-gray-600 focus-visible:border-[#34b4f5] focus-visible:ring-[#34b4f5]/30"
                          {...field}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          aria-label={showPassword ? "Hide password" : "Show password"}
                          aria-pressed={showPassword}
                          tabIndex={-1}
                          className="absolute top-1/2 right-2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-gray-500 transition-colors hover:text-gray-300"
                        >
                          {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button
                type="submit"
                disabled={isLoggingIn}
                className="login-submit flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[#34b4f5] text-[15px] font-semibold text-black hover:bg-[#1fa3e6]"
              >
                {isLoggingIn ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Signing in…
                  </>
                ) : (
                  <>
                    Sign in
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
            </form>
          </Form>

          {isMockMode && (
            <div className="mt-6 space-y-2 rounded-md border border-[#262626] bg-[#181818] p-4">
              <p className="text-xs font-medium text-gray-500">
                Mock mode demo accounts. Password: <code className="font-mono text-gray-300">{DEMO_PASSWORD}</code>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {DEMO_CREDENTIALS.map((cred) => (
                  <button
                    key={cred.email}
                    type="button"
                    onClick={() => setPrefill(cred.email)}
                    className="inline-flex min-h-9 items-center rounded-md border border-[#262626] bg-[#111111] px-2.5 text-xs font-medium text-gray-300 transition-colors hover:border-gray-600 hover:bg-[#181818] hover:text-white"
                  >
                    {cred.role.replace("_", " ")}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
