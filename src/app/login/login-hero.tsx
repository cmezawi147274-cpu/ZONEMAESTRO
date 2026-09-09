import Image from "next/image"

/** Illustrative example zones — static, presentational mock content (this
 * login screen has never shown live data; the real zone list only exists
 * behind auth). Copy/status vocabulary matches the reference exactly. */
const HERO_ZONES = [
  { name: "Dining Room", status: "live", color: "#4ade80" },
  { name: "The Bar", status: "live", color: "#4ade80" },
  { name: "Kitchen", status: "hold", color: "#fbbf24" },
  { name: "Terrace", status: "offline", color: "#9ca3af" },
]

export function LoginHero() {
  return (
    // Width comes from the parent grid's `7fr` column. It must NOT also carry
    // a `w-[70%]`: that resolves against the column, not the viewport, and
    // shrinks the stage to 49% of the page — which clipped the headline.
    <section className="login-form-enter relative hidden min-h-screen overflow-hidden lg:block">
      <Image
        src="/branding/login-hero-scene-v2.jpg"
        alt="Dark luxury audio lounge interior"
        fill
        priority
        sizes="70vw"
        className="object-cover"
        style={{ objectPosition: "58% 50%" }}
      />

      {/* Cinematic overlay — matches the reference exactly: a vertical
          darken (heavier at the bottom, where the headline sits) plus a
          gentle horizontal one from the left. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(2,4,6,0.62) 0%, rgba(2,4,6,0.26) 38%, rgba(2,4,6,0.88) 100%), linear-gradient(90deg, rgba(2,4,6,0.44) 0%, rgba(2,4,6,0.08) 58%, rgba(2,4,6,0.28) 100%)",
        }}
      />

      {/* One flow column instead of three independently-positioned blocks.
          Absolutely centring the wordmark let it drift into the lockup on
          short/wide windows; as flex rows the three can never collide, at
          any viewport. */}
      <div className="relative flex min-h-screen flex-col justify-between p-10">
        {/* Icon + "Precision Audio Orchestration" lockup, baked into the one
            asset — screen-blended so its black background disappears. */}
        <Image
          src="/branding/login-mark-trimmed.png"
          alt="ZoneMaestro — Precision Audio Orchestration"
          width={467}
          height={425}
          priority
          draggable={false}
          className="h-auto w-[clamp(7.5rem,9vw,10rem)] select-none"
          // Inline, not utilities: `contrast-125` and an arbitrary
          // `[filter:drop-shadow(…)]` both write `filter`, so one silently
          // clobbers the other. One declaration keeps the whole chain.
          style={{
            mixBlendMode: "screen",
            filter: "contrast(1.25) drop-shadow(0 8px 22px rgba(0, 0, 0, 0.5))",
          }}
        />

        {/* The wordmark, set as live text rather than the source PNG. That
            art is 3D extruded lettering on a light card; inverting it to
            composite onto the photo also inverts its drop-shadows into a
            hard white glow around every glyph, which the reference doesn't
            have. Montserrat 700 reproduces the flat lockup directly. */}
        <p className="text-[clamp(2.75rem,4.6vw,4.5rem)] leading-none font-bold tracking-[-0.02em] whitespace-nowrap text-[#c9d3dc] select-none">
          Zone<span className="text-[#7fb2d8]">Maestro</span>
        </p>

        {/* Headline + illustrative zone status row. */}
        <div className="max-w-2xl">
          <h1 className="text-[2.75rem] leading-[1.08] font-bold tracking-tight whitespace-nowrap text-white">
            Music that moves with your space
          </h1>
          <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-3">
            {HERO_ZONES.map((z) => (
              <div key={z.name} className="flex items-center gap-2 text-[13px]">
                <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: z.color }} />
                <span className="font-medium text-white">{z.name}</span>
                <span className="text-gray-400">{z.status}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
