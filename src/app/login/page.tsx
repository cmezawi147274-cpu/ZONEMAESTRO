"use client"

import { useState } from "react"
import Link from "next/link"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { Eye, EyeOff, Loader2 } from "lucide-react"
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
import { LoginStage } from "@/app/login/login-stage"
import { ZoneMaestroWordmark } from "@/app/login/wordmark"
import { useAuth } from "@/hooks/use-auth"
import { isMockMode } from "@/lib/config"
import { DEMO_CREDENTIALS, DEMO_PASSWORD } from "@/lib/mock/seed"
import { cn } from "@/lib/utils"

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
    <div className="login-shell dark min-h-[100dvh] bg-[var(--login-bg)] text-foreground">
      <div className="grid min-h-[100dvh] lg:grid-cols-[minmax(0,1.2fr)_minmax(22.5rem,26.5rem)]">
        <LoginStage />

        <div className="flex min-h-[100dvh] w-full items-center justify-center bg-[var(--login-panel)] p-6 sm:p-10 lg:border-l lg:border-white/10">
          <div className="login-form-enter w-full max-w-[22rem] space-y-8">
            <ZoneMaestroWordmark className="lg:hidden" compact />

            <div className="space-y-2">
              <h1 className="text-[1.65rem] leading-tight font-semibold tracking-tight">
                Sign in
              </h1>
              <p className="text-sm leading-relaxed text-foreground/55">
                Organizations, music, and connected servers.
              </p>
            </div>

            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className={cn("space-y-5", loginError && "login-error-shake")}
              >
                {loginError && (
                  <Alert variant="destructive" className="border-red-500/20 bg-red-500/10">
                    <AlertDescription>
                      {loginError.message} Check the email and password, then try
                      again.
                    </AlertDescription>
                  </Alert>
                )}
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-foreground/80">Email</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="you@company.com"
                          autoComplete="email"
                          autoFocus
                          className="h-11 rounded-xl border-white/10 bg-white/5 px-3 text-base md:text-sm focus-visible:border-[#5ec8f7] focus-visible:ring-[#5ec8f7]/35"
                          {...field}
                        />
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
                      <FormLabel className="text-foreground/80">Password</FormLabel>
                      <div className="relative">
                        <FormControl>
                          <Input
                            type={showPassword ? "text" : "password"}
                            autoComplete="current-password"
                            className="h-11 rounded-xl border-white/10 bg-white/5 px-3 pr-11 text-base md:text-sm focus-visible:border-[#5ec8f7] focus-visible:ring-[#5ec8f7]/35"
                            {...field}
                          />
                        </FormControl>
                        <button
                          type="button"
                          aria-label={showPassword ? "Hide password" : "Show password"}
                          aria-pressed={showPassword}
                          onClick={() => setShowPassword((open) => !open)}
                          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-foreground/50 transition-[color,transform] duration-150 [transition-timing-function:var(--ease-out)] hover:text-foreground active:scale-[0.97]"
                        >
                          {showPassword ? (
                            <EyeOff className="size-4" aria-hidden="true" />
                          ) : (
                            <Eye className="size-4" aria-hidden="true" />
                          )}
                        </button>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  disabled={isLoggingIn}
                  className="login-submit h-11 w-full rounded-xl border-transparent active:translate-y-0 active:scale-[0.97] hover:bg-[#7dd3fc]"
                >
                  {isLoggingIn && <Loader2 className="size-4 animate-spin" />}
                  Sign in
                </Button>
              </form>
            </Form>

            {isMockMode && (
              <div className="space-y-2">
                <p className="text-xs text-foreground/45">
                  Demo accounts. Password{" "}
                  <code className="font-mono text-foreground/70">{DEMO_PASSWORD}</code>
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {DEMO_CREDENTIALS.map((cred) => (
                    <button
                      key={cred.email}
                      type="button"
                      onClick={() => setPrefill(cred.email)}
                      className="rounded-xl border border-white/10 px-2.5 py-1.5 text-xs font-medium text-foreground/70 transition-[background-color,color] duration-150 [transition-timing-function:var(--ease-out)] hover:bg-white/10 hover:text-foreground"
                    >
                      {cred.role.replaceAll("_", " ").toLowerCase()}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-3">
              <p className="text-[11px] leading-relaxed text-foreground/40">
                Encrypted session. MusicServers pair outbound only.
              </p>
              <p className="text-xs leading-relaxed text-foreground/50">
                Windows MusicServer administrator?{" "}
                <Link
                  href="/servers"
                  className="font-medium text-foreground/80 underline decoration-foreground/25 underline-offset-4 transition-[color] duration-150 [transition-timing-function:var(--ease-out)] hover:text-foreground"
                >
                  Manage server pairing
                </Link>{" "}
                after signing in.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
