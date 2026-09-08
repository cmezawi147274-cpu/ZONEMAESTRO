import Image from "next/image"

const ICON_SRC = "/branding/zonemaestro-icon.jpg"

/** Illustrative example zones — the same kind of static, presentational
 * mock content this login screen has always used (never live data; the
 * real zone list only exists behind auth). Wording/status vocabulary
 * ("live"/"hold") matches the reference screenshot, not the app's own
 * ZonePlaybackState enum. */
const HERO_ZONES = [
  { name: "Dining Room", status: "live" as const },
  { name: "The Bar", status: "live" as const },
  { name: "Kitchen", status: "hold" as const },
  { name: "Terrace", status: "offline" as const },
]

const STATUS_DOT: Record<string, string> = {
  live: "bg-emerald-400",
  hold: "bg-amber-400",
  offline: "bg-white/30",
}

export function LoginHero({
  /** Real venue photo, once available — swap this one prop in and the
   * placeholder gradient below is gone. Nothing else about this
   * component changes. */
  photoSrc,
}: {
  photoSrc?: string
}) {
  return (
    <div className="login-form-enter relative h-[42vh] w-full overflow-hidden lg:h-auto lg:w-[70%]">
      {photoSrc ? (
        <Image src={photoSrc} alt="" fill priority sizes="70vw" className="object-cover" />
      ) : (
        // PLACEHOLDER — no real venue photo has been supplied yet (see
        // chat). Replace by passing `photoSrc` from page.tsx once one is
        // uploaded; everything else on this panel is already final.
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(700px circle at 72% 28%, rgba(94,200,247,0.10), transparent 60%), radial-gradient(500px circle at 25% 75%, rgba(255,196,120,0.06), transparent 60%), linear-gradient(180deg, #0b0d10 0%, #101215 100%)",
          }}
        />
      )}

      {/* Cinematic overlay — darkens the photo so type stays readable at
          every corner it appears in, independent of what the photo is. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/70 via-black/35 to-black/80"
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-black/20" />

      {/* Top-left: icon mark + tracked caps caption */}
      <div className="relative flex items-center gap-3 p-8 xl:p-12">
        <Image src={ICON_SRC} alt="ZoneMaestro" width={56} height={56} priority className="size-10 rounded-md xl:size-12" />
        <p className="text-[11px] leading-tight font-semibold tracking-[0.22em] text-white/90 uppercase">
          Precision Audio
          <br />
          Orchestration
        </p>
      </div>

      {/* Center: large metallic/glass wordmark */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8">
        <h1
          className="bg-gradient-to-b from-white via-slate-300 to-slate-500 bg-clip-text text-center text-6xl leading-none font-bold tracking-tight text-transparent xl:text-8xl"
          style={{ filter: "drop-shadow(0 4px 24px rgba(94,200,247,0.18))" }}
        >
          ZoneMaestro
        </h1>
      </div>

      {/* Bottom-left: tagline + illustrative zone status row */}
      <div className="relative flex flex-col gap-4 p-8 xl:p-12">
        <p className="text-2xl font-semibold text-white xl:text-3xl">Music that moves with your space</p>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {HERO_ZONES.map((z) => (
            <span key={z.name} className="flex items-center gap-1.5 text-sm">
              <span aria-hidden className={`size-2 rounded-full ${STATUS_DOT[z.status]}`} />
              <span className="font-medium text-white">{z.name}</span>
              <span className="text-white/50">{z.status}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
