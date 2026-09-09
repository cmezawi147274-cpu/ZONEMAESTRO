import { cn } from "@/lib/utils"

export function ZoneMaestroWordmark({
  className,
  compact = false,
}: {
  className?: string
  compact?: boolean
}) {
  return (
    <div
      className={cn("flex items-center gap-3", className)}
      role="img"
      aria-label="ZoneMaestro"
    >
      <svg
        viewBox="0 0 40 40"
        className="size-10 shrink-0"
        aria-hidden="true"
      >
        <rect
          x="0.75"
          y="0.75"
          width="38.5"
          height="38.5"
          rx="11"
          fill="#0b0d10"
          stroke="#5ec8f7"
          strokeOpacity="0.55"
          strokeWidth="1.5"
        />
        <g fill="#5ec8f7">
          <rect x="9" y="18" width="3.5" height="13" rx="1.2" opacity="0.45" />
          <rect x="15.2" y="10" width="3.5" height="21" rx="1.2" />
          <rect x="21.4" y="14" width="3.5" height="17" rx="1.2" opacity="0.8" />
          <rect x="27.6" y="21" width="3.5" height="10" rx="1.2" opacity="0.35" />
        </g>
      </svg>
      <div className="min-w-0 leading-none" aria-hidden="true">
        <p className="text-[1.15rem] font-semibold tracking-tight text-foreground">
          Zone<span className="text-[#5ec8f7]">Maestro</span>
        </p>
        {!compact && (
          <p className="mt-1.5 text-[0.62rem] font-medium tracking-[0.2em] text-foreground/45 uppercase">
            Precision audio orchestration
          </p>
        )}
      </div>
    </div>
  )
}
