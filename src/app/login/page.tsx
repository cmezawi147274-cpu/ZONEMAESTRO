"use client"

import { useState } from "react"
import Link from "next/link"
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
import { isMockMode } from "@/lib/config"
import { DEMO_CREDENTIALS, DEMO_PASSWORD } from "@/lib/mock/seed"
import { cn } from "@/lib/utils"
import { LoginHero } from "@/app/login/login-hero"

// No real venue photo has been supplied yet — see chat. Pass its path
// here the moment one lands under public/, e.g. "/branding/zonemaestro-venue-bg.jpg".
// Nothing else on the page changes.
const HERO_PHOTO_SRC: string | undefined = undefined

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
    <div className="flex min-h-screen flex-col bg-[#0b0d10] lg:flex-row">
      <LoginHero photoSrc={HERO_PHOTO_SRC} />

      {/* `dark` scopes shadcn's dark token set (Alert, FormMessage, Form
          error states) to just this panel, without a global theme toggle —
          otherwise Alert's destructive variant renders a white box (its
          `bg-card` reads the app's default light `:root` tokens). */}
      <div className="dark flex flex-1 items-center justify-center bg-[#101215] p-6 sm:p-10 lg:w-[30%]">
        <div className="login-form-enter w-full max-w-sm space-y-6">
          <div className="space-y-1.5">
            <h2 className="text-2xl font-bold tracking-tight text-white">Sign in</h2>
            <p className="text-sm text-white/50">Group operators and venue administrators.</p>
          </div>

          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className={cn("space-y-4", loginError && "login-error-shake")}
            >
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
                    <FormLabel className="text-sm text-white/70">Email</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-white/35" />
                        <Input
                          placeholder="ops@group.example"
                          autoComplete="email"
                          autoFocus
                          className="h-12 rounded-[10px] border-white/10 bg-white/[0.04] pl-10 text-base text-white placeholder:text-white/30 focus-visible:border-[#5ec8f7] focus-visible:ring-[#5ec8f7]/40"
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
                  <FormItem>
                    <FormLabel className="text-sm text-white/70">Password</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Lock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-white/35" />
                        <Input
                          type={showPassword ? "text" : "password"}
                          autoComplete="current-password"
                          className="h-12 rounded-[10px] border-white/10 bg-white/[0.04] pr-11 pl-10 text-base text-white placeholder:text-white/30 focus-visible:border-[#5ec8f7] focus-visible:ring-[#5ec8f7]/40"
                          {...field}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          aria-label={showPassword ? "Hide password" : "Show password"}
                          aria-pressed={showPassword}
                          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-white/40 transition-colors hover:text-white"
                        >
                          {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
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
                className="login-submit h-12 w-full gap-1.5 rounded-[10px] bg-[#5ec8f7] text-base font-semibold text-[#0b0d10] hover:bg-[#5ec8f7]/90"
              >
                {isLoggingIn ? <Loader2 className="size-4 animate-spin" /> : null}
                Sign in
                {!isLoggingIn && <ArrowRight className="size-4" />}
              </Button>
            </form>
          </Form>

          {isMockMode && (
            <div className="space-y-2 rounded-[10px] border border-white/10 bg-white/[0.03] p-4">
              <p className="text-xs font-medium text-white/45">
                Mock mode demo accounts. Password: <code className="font-mono text-white/70">{DEMO_PASSWORD}</code>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {DEMO_CREDENTIALS.map((cred) => (
                  <button
                    key={cred.email}
                    type="button"
                    onClick={() => setPrefill(cred.email)}
                    className="inline-flex min-h-9 items-center rounded-md border border-white/10 bg-white/[0.03] px-2.5 text-xs font-medium text-white/70 transition-colors hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
                  >
                    {cred.role.replace("_", " ")}
                  </button>
                ))}
              </div>
            </div>
          )}

          <p className="text-center text-xs text-white/40">
            Windows MusicServer administrator?{" "}
            <Link
              href="/servers"
              className="font-medium text-white/70 underline underline-offset-2 hover:text-[#5ec8f7]"
            >
              Manage server pairing
            </Link>{" "}
            after signing in.
          </p>
        </div>
      </div>
    </div>
  )
}
