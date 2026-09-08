import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export interface BreakdownSegment {
  key: string
  label: string
  count: number
  barColor: string
  dotColor: string
  textColor: string
}

/**
 * A labeled, segmented proportion bar for a status dimension (server
 * status, sync status, …). Colors are the same fixed status palette used
 * across badges — reserved semantics, never repurposed as categorical
 * series — and every segment carries a direct label + count, so identity
 * never depends on color alone.
 */
export function StatusBreakdown({ title, segments }: { title: string; segments: BreakdownSegment[] }) {
  const total = segments.reduce((sum, s) => sum + s.count, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
          {segments
            .filter((s) => s.count > 0)
            .map((s) => (
              <div
                key={s.key}
                className={cn("h-full first:rounded-l-full last:rounded-r-full", s.barColor)}
                style={{ width: `${total > 0 ? (s.count / total) * 100 : 0}%` }}
                title={`${s.label}: ${s.count}`}
              />
            ))}
          {total === 0 && <div className="h-full w-full rounded-full bg-muted" />}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          {segments.map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-sm">
              <span className={cn("size-2 shrink-0 rounded-full", s.dotColor)} />
              <dt className="flex-1 truncate text-muted-foreground">{s.label}</dt>
              <dd className={cn("font-medium tabular-nums", s.textColor)}>{s.count}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  )
}
