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
    <section className="login-form-enter relative hidden min-h-screen overflow-hidden lg:block lg:w-[70%]">
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

      {/* Top-left: icon + "Precision Audio Orchestration" lockup, baked
          into the one asset — screen-blended so its black background
          disappears into the page. */}
      <div className="absolute top-0 left-0 p-10">
        <Image
          src="/branding/login-mark.jpg"
          alt="ZoneMaestro — Precision Audio Orchestration"
          width={300}
          height={300}
          priority
          draggable={false}
          className="w-[180px] mix-blend-screen contrast-125 [filter:drop-shadow(0_8px_22px_rgba(0,0,0,0.5))] select-none xl:w-[220px]"
        />
      </div>

      {/* Center-left: the wordmark. Source art is dark text on a light
          card — inverted + hue-rotated back to blue-gray, then
          screen-blended, so only the lettering composites onto the photo. */}
      <div className="absolute top-1/2 left-10 -translate-y-1/2">
        <Image
          src="/branding/login-wordmark.png"
          alt="ZoneMaestro"
          width={844}
          height={198}
          priority
          draggable={false}
          className="w-[min(60vw,900px)] mix-blend-screen select-none [filter:invert(1)_hue-rotate(180deg)_contrast(1.15)]"
        />
      </div>

      {/* Bottom-left: headline + illustrative zone status row. */}
      <div className="absolute bottom-0 left-0 max-w-2xl p-10">
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
    </section>
  )
}
