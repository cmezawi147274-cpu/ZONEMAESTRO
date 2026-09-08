import { cn } from "@/lib/utils"

/**
 * ZoneMaestro brand mark. One place to swap if the brand changes again —
 * every other spot (sidebar, login) composes these two pieces rather than
 * hardcoding a name or icon of its own.
 *
 * Hand-built vector recreation of the supplied artwork's actual
 * composition — nested signal arcs merging into a bold Z, a sharp peak
 * breaking into a diagonal spike top-right — not a pixel copy (no tool
 * available here can pull the chat attachment's bytes onto this
 * filesystem). The arcs are drawn as clipped full circles rather than SVG
 * arc-flag paths specifically so the geometry is unambiguous without a
 * way to render-and-check.
 */
export function LogoMark({ className, bare }: { className?: string; bare?: boolean }) {
  const mark = (
    <svg viewBox="0 0 100 100" className="size-full" fill="none">
      <defs>
        <linearGradient id="zm-metal" x1="0" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#f8fafc" />
          <stop offset="0.5" stopColor="#e2e8f0" />
          <stop offset="1" stopColor="#8fa3ba" />
        </linearGradient>
        <linearGradient id="zm-accent" x1="0.2" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#7dd3fc" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
        <clipPath id="zm-arc-clip">
          <rect x="0" y="0" width="29" height="100" />
        </clipPath>
      </defs>
      {/* Nested signal arcs — full circles clipped to their left half, so
          the curve direction is exact rather than guessed from SVG arc
          sweep flags. */}
      <g clipPath="url(#zm-arc-clip)" stroke="url(#zm-accent)" fill="none" strokeLinecap="round">
        <circle cx="29" cy="56" r="7" strokeWidth="4.5" opacity="0.95" />
        <circle cx="29" cy="56" r="14" strokeWidth="4" opacity="0.7" />
        <circle cx="29" cy="56" r="21" strokeWidth="3.5" opacity="0.45" />
        <circle cx="29" cy="56" r="28" strokeWidth="3" opacity="0.25" />
      </g>
      {/* Bold Z, sitting just right of the arc cluster */}
      <path
        d="M 35 24 L 73 24 L 37 76 L 77 76"
        stroke="url(#zm-metal)"
        strokeWidth="12.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Peak + spike — shares the Z's top-right corner, breaks out past
          the frame the way the reference artwork's diagonal does. */}
      <path
        d="M 51 63 L 73 24 L 95 9"
        stroke="url(#zm-accent)"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )

  if (bare) return <div className={cn("shrink-0", className)}>{mark}</div>

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-slate-800 to-blue-900 p-[18%]",
        className
      )}
    >
      {mark}
    </div>
  )
}

/** "Zone" in the surrounding text color, "Maestro" in the brand accent —
 * matches the artwork's silver/blue split. `light` flips both halves to a
 * light-on-dark pairing for use on the login hero panel. Pass `className`
 * for size/weight/font — see src/app/login/page.tsx for the rounder
 * display face used there. */
export function LogoWordmark({ className, light }: { className?: string; light?: boolean }) {
  return (
    <span className={cn("font-semibold tracking-tight", className)}>
      <span className={light ? "text-white" : "text-foreground"}>Zone</span>
      <span className={light ? "text-sky-300" : "text-sky-500"}>Maestro</span>
    </span>
  )
}
