import { cn } from "@/lib/utils"

export function EqBars({
  bars = 9,
  active,
  className,
}: {
  bars?: number
  active: boolean
  className?: string
}) {
  return (
    <div
      className={cn("flex h-7 items-end gap-px", className)}
      aria-hidden="true"
    >
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={cn(
            "login-eq-bar w-0.5 rounded-full",
            active ? "bg-[var(--login-accent)]" : "bg-foreground/20"
          )}
          style={{
            height: `${34 + ((i * 37) % 66)}%`,
            animationDelay: `${i * 70}ms`,
            animationDuration: `${900 + (i % 6) * 110}ms`,
            animationPlayState: active ? "running" : "paused",
          }}
        />
      ))}
    </div>
  )
}
