"use client"

import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { ThemeProvider } from "next-themes"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  )

  return (
    <QueryClientProvider client={queryClient}>
      {/* attribute="class" matches globals.css' `@custom-variant dark
          (&:is(.dark *))` — next-themes toggles a `.dark` class on <html>,
          the same selector the whole `.dark { … }` token block (and every
          `dark:` Tailwind variant in the app) already keys off. defaultTheme
          "system" plus enableSystem means an operator who never touches the
          toggle still gets their OS preference; layout.tsx's
          suppressHydrationWarning on <html> is what next-themes' own docs
          call for so its pre-hydration class doesn't trip React's
          mismatch warning. */}
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <TooltipProvider delay={200}>
          {children}
          <Toaster richColors position="top-right" />
        </TooltipProvider>
        {process.env.NODE_ENV !== "production" && <ReactQueryDevtools initialIsOpen={false} />}
      </ThemeProvider>
    </QueryClientProvider>
  )
}
