import Image from "next/image"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"

const linkClass =
  "rounded-sm transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#34b4f5]/50"

/** Shared chrome for the public Terms of Service and Privacy Policy pages.
 * Same palette, face and logo treatment as /login. */
export default function PoliciesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="dark flex min-h-screen flex-col bg-[#111111] text-white"
      style={{ fontFamily: "var(--font-logo), ui-sans-serif, system-ui, sans-serif" }}
    >
      {/* Keeps overscroll on the page's dark ground instead of the theme background. */}
      <style>{`html{background-color:#111111}`}</style>

      <header className="mx-auto flex w-full max-w-3xl items-start justify-between px-6 pt-10 sm:px-10">
        <Link href="/login" aria-label="ZoneMaestro sign in" className={linkClass}>
          <Image
            src="/branding/login-mark-trimmed.png"
            alt="ZoneMaestro — Precision Audio Orchestration"
            width={467}
            height={425}
            priority
            draggable={false}
            className="h-auto w-[120px] select-none"
            style={{
              mixBlendMode: "screen",
              filter: "contrast(1.25) drop-shadow(0 8px 22px rgba(0, 0, 0, 0.5))",
            }}
          />
        </Link>
        <Link href="/login" className={`${linkClass} mt-1 inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-400`}>
          <ArrowLeft className="h-4 w-4" />
          Back to sign in
        </Link>
      </header>

      <main className="login-form-enter mx-auto w-full max-w-3xl flex-1 px-6 pt-12 pb-16 sm:px-10">{children}</main>

      <footer className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 border-t border-[#262626] px-6 py-8 text-xs text-gray-500 sm:px-10">
        <p>© 2026 ZoneMaestro</p>
        <nav className="flex gap-5">
          <Link href="/terms-of-service" className={linkClass}>Terms of Service</Link>
          <Link href="/privacy-policy" className={linkClass}>Privacy Policy</Link>
        </nav>
      </footer>
    </div>
  )
}
