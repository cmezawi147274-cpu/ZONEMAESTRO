import { EqBars } from "@/app/login/eq-bars"
import { ZoneMaestroWordmark } from "@/app/login/wordmark"
import { cn } from "@/lib/utils"

const FLOOR = [
  {
    zone: "Dining Area",
    playlist: "Dinner Lounge",
    state: "PLAYING",
  },
  {
    zone: "Bar",
    playlist: "Bar Late Night",
    state: "PLAYING",
  },
  {
    zone: "Kitchen",
    playlist: "Lunch Upbeat",
    state: "PAUSED",
  },
  {
    zone: "Outdoor Patio",
    playlist: null,
    state: "OFFLINE",
  },
] as const

const STATE_TONE: Record<(typeof FLOOR)[number]["state"], string> = {
  PLAYING: "text-emerald-400",
  PAUSED: "text-amber-400",
  OFFLINE: "text-red-400",
}

export function LoginStage() {
  return (
    <section className="relative hidden min-h-[100dvh] flex-col justify-between overflow-hidden px-10 py-10 lg:flex xl:px-16 xl:py-12">
      <div
        aria-hidden="true"
        className="login-stage-grid pointer-events-none absolute inset-0"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-24 top-1/3 size-[28rem] rounded-full bg-[#5ec8f7]/8 blur-3xl"
      />

      <ZoneMaestroWordmark className="relative" />

      <div className="relative max-w-lg space-y-10">
        <div className="space-y-4">
          <p className="text-5xl leading-[1.06] font-semibold tracking-tight text-foreground xl:text-[3.35rem]">
            Every room, one desk.
          </p>
          <p className="max-w-[38ch] text-base leading-relaxed text-foreground/60">
            The cloud holds the library. Each MusicServer caches and plays on
            its own, even offline.
          </p>
        </div>

        <div className="space-y-5">
          <p className="text-[11px] font-medium tracking-[0.16em] text-foreground/45 uppercase">
            Downtown Bistro
          </p>
          <ul className="space-y-1">
            {FLOOR.map((row) => (
              <li
                key={row.zone}
                className="grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-1 py-2.5"
              >
                <EqBars active={row.state === "PLAYING"} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {row.zone}
                  </p>
                  <p className="truncate text-xs text-foreground/45">
                    {row.playlist ?? "No playlist assigned"}
                  </p>
                </div>
                <span
                  className={cn(
                    "text-[10px] font-medium tracking-[0.14em] uppercase",
                    STATE_TONE[row.state]
                  )}
                >
                  {row.state}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="relative text-xs text-foreground/35">© 2026 ZoneMaestro</p>
    </section>
  )
}
