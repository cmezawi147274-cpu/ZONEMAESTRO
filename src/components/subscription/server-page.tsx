"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { ArrowLeft, BellRing, CalendarClock, Download, Loader2, X } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAuth } from "@/hooks/use-auth"
import type { ServerInfo, SubscriptionEvent, SubscriptionRecord } from "@/components/subscription/api"
import {
  useChangeSubscriptionDuration,
  useDismissSubscriptionBanner,
  useExportSubscription,
  useRenewSubscription,
  useSaveSubscriptionNotes,
  useSaveSubscriptionReminders,
  useServerSubscription,
  useServerSubscriptionClock,
} from "@/components/subscription/hooks"
import { BAND_LABEL, DAY_MS, REMINDER_DAYS, addCalendarMonthsUTC, ageLabel, derive, formatSpan, formatUTC, type Band, type Span } from "@/components/subscription/derive"

export const BAND_CLASS: Record<Band | "not_started", string> = {
  active: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  attention: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  critical: "bg-destructive/10 text-destructive",
  ended: "bg-muted text-muted-foreground",
  not_started: "border-border text-muted-foreground",
}

const DURATION_PRESETS = [1, 3, 6, 12, 24, 36]
const monthsLabel = (n: number) => `${n} month${n === 1 ? "" : "s"}`

const FIRST_CONNECTION_FIELDS: [string, string][] = [
  ["source", "Connected via"],
  ["version", "Agent version"],
  ["ipAddress", "IP at first connection"],
  ["caps", "Capabilities"],
]

const COUNTDOWN_MARKS = [
  { label: "30 days left", days: 30, className: "bg-amber-500" },
  { label: "7 days left", days: 7, className: "bg-destructive" },
  { label: "End", days: 0, className: "bg-foreground" },
]

function eventLabel(e: SubscriptionEvent): string {
  switch (e.type) {
    case "created":
      return "Created on the first venue connection"
    case "carried_over":
      return e.note ? `Carried over: ${e.note}` : "Carried over"
    case "restarted":
      return "Cloud service restarted"
    case "threshold":
      return e.threshold === "ended" ? "Term ended" : `${e.threshold} days left`
    case "note_saved":
      return `Note saved${e.by ? ` by ${e.by.email}` : ""}`
    case "reminders_saved":
      return `Reminders saved${e.by ? ` by ${e.by.email}` : ""}`
    case "exported":
      return `Exported (${e.format === "text" ? "summary" : "JSON"})${e.by ? ` by ${e.by.email}` : ""}`
    case "renewal_confirmed":
      return `Renewal confirmed${e.by ? ` by ${e.by.email}` : ""}`
    case "duration_changed":
      return `Duration changed from ${monthsLabel(e.previousDurationMonths ?? 0)} to ${monthsLabel(e.durationMonths ?? 0)}${e.by ? ` by ${e.by.email}` : ""}`
    default:
      return e.type
  }
}

function SpanBlocks({ span }: { span: Span }) {
  const items: [number, string][] = [
    [span.months, "months"],
    [span.days, "days"],
    [span.hours, "hours"],
    [span.minutes, "minutes"],
  ]
  return (
    <div className="grid grid-cols-4 gap-2">
      {items.map(([value, label]) => (
        <div key={label} className="rounded-lg border p-3 text-center">
          <p className="text-2xl font-semibold tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      ))}
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right break-all">{value}</span>
    </div>
  )
}

function Content({ server, record, now }: { server: ServerInfo; record: SubscriptionRecord; now: string }) {
  const d = derive(record.startedAt, record.endsAt, now, record)
  const dismiss = useDismissSubscriptionBanner(server.serverId)
  const saveReminders = useSaveSubscriptionReminders(server.serverId)
  const saveNotes = useSaveSubscriptionNotes(server.serverId)
  const exportFile = useExportSubscription(server.serverId)
  const renew = useRenewSubscription(server.serverId)
  const changeDuration = useChangeSubscriptionDuration(server.serverId)
  const [notes, setNotes] = useState(record.notes)
  const [typedEnd, setTypedEnd] = useState("")
  const isPreset = DURATION_PRESETS.includes(record.durationMonths)
  const [durationChoice, setDurationChoice] = useState(isPreset ? String(record.durationMonths) : "custom")
  const [customMonths, setCustomMonths] = useState(isPreset ? "" : String(record.durationMonths))
  const [typedDurationEnd, setTypedDurationEnd] = useState("")
  const chosenMonths = Number(durationChoice === "custom" ? customMonths : durationChoice)
  const monthsValid = Number.isInteger(chosenMonths) && chosenMonths >= 1 && chosenMonths <= 60
  const currentTerm = record.terms[record.terms.length - 1]
  const previewEnd = monthsValid ? addCalendarMonthsUTC(new Date(currentTerm.startedAt), chosenMonths).toISOString() : null
  const endDate = record.endsAt.slice(0, 10)
  const meta = record.createdByConnection

  function toggleReminder(days: number, on: boolean) {
    const next = REMINDER_DAYS.filter((r) => (r === days ? on : record.reminderDays.includes(r)))
    saveReminders.mutate(next)
  }

  return (
    <div className="space-y-6">
      {d.banner !== null && (
        <Alert>
          <BellRing />
          <AlertTitle>{d.banner} day reminder</AlertTitle>
          <AlertDescription>
            {server.name}&apos;s subscription ends on {formatUTC(record.endsAt)}.
          </AlertDescription>
          <AlertAction>
            <Button variant="ghost" size="icon-sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate(d.banner!)}>
              <X className="size-4" />
            </Button>
          </AlertAction>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Overview <Badge className={BAND_CLASS[d.band]}>{BAND_LABEL[d.band]}</Badge>
          </CardTitle>
          <CardDescription>Time left, from the server clock at {formatUTC(now)}.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SpanBlocks span={d.countdown} />
          <div className="space-y-1.5">
            <Row label="Start" value={formatUTC(record.startedAt)} />
            <Row label="End" value={formatUTC(record.endsAt)} />
            <Row label="Elapsed" value={formatSpan(d.elapsed)} />
            <Row label="Complete" value={`${d.percent.toFixed(1)}%`} />
          </div>
          <div className="space-y-3 pt-2">
            <div className="relative pb-5">
              <div className="relative h-2 w-full rounded-full bg-muted">
                <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${d.percent}%` }} />
                {d.marks.map((m) => (
                  <div
                    key={m.label}
                    className={`absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full ${COUNTDOWN_MARKS.find((c) => c.label === m.label)?.className ?? "bg-foreground/40"}`}
                    style={{ left: `${m.percent}%` }}
                  />
                ))}
              </div>
              {d.marks
                .filter((m) => m.label.endsWith("%"))
                .map((m) => (
                  <span key={m.label} className="absolute top-4 -translate-x-1/2 text-[10px] text-muted-foreground" style={{ left: `${m.percent}%` }}>
                    {m.label}
                  </span>
                ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {COUNTDOWN_MARKS.map((c) => (
                <span key={c.label} className="flex items-center gap-1.5">
                  <span className={`h-3 w-0.5 rounded-full ${c.className}`} />
                  {c.label} · {formatUTC(new Date(new Date(record.endsAt).getTime() - c.days * DAY_MS).toISOString())}
                </span>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>This server</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {d.clockBehind && (
            <Alert variant="destructive" className="mb-3">
              <AlertTitle>Server clock is behind the subscription start</AlertTitle>
            </Alert>
          )}
          <Row label="Server" value={server.name} />
          <Row label="Organization" value={server.organizationName ?? "-"} />
          <Row label="Server id" value={<span className="font-mono text-xs">{server.serverId}</span>} />
          <Row label="Record id" value={<span className="font-mono text-xs">{record.id}</span>} />
          <Row label="First connection" value={formatUTC(record.startedAt)} />
          {FIRST_CONNECTION_FIELDS.filter(([key]) => key in meta).map(([key, label]) => {
            const value = meta[key]
            return <Row key={key} label={label} value={Array.isArray(value) ? value.join(", ") || "-" : value == null || value === "" ? "-" : String(value)} />
          })}
          <Row label="Connections" value={record.connectionCount} />
          <Row label="Last connection" value={`${formatUTC(record.lastConnectionAt)} (${ageLabel(record.lastConnectionAt, now)})`} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Term history</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {record.terms.map((t) => (
            <div key={t.index} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span>
                {t.index}. {formatUTC(t.startedAt)} to {formatUTC(t.endsAt)}
              </span>
              <span className="text-muted-foreground">
                {t.reason} · {t.confirmedBy.type === "user" ? t.confirmedBy.email : t.confirmedBy.label}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {[...record.events].reverse().map((e) => (
            <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span>{eventLabel(e)}</span>
              <span className="text-muted-foreground">
                {formatUTC(e.at)} · term {e.term}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reminders</CardTitle>
          <CardDescription>Shown on this page only.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {REMINDER_DAYS.map((days) => (
            <div key={days} className="flex items-center justify-between">
              <Label>
                {days} {days === 1 ? "day" : "days"} before the end
              </Label>
              <Switch
                checked={record.reminderDays.includes(days)}
                disabled={saveReminders.isPending}
                onCheckedChange={(on) => toggleReminder(days, on)}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} maxLength={10_000} />
          <Button size="sm" disabled={saveNotes.isPending || notes === record.notes} onClick={() => saveNotes.mutate(notes)}>
            {saveNotes.isPending && <Loader2 className="size-4 animate-spin" />}
            Save note
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Export</CardTitle>
          <CardDescription>This server&apos;s record only.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={exportFile.isPending} onClick={() => exportFile.mutate("json")}>
            <Download className="size-4" /> JSON snapshot
          </Button>
          <Button variant="outline" size="sm" disabled={exportFile.isPending} onClick={() => exportFile.mutate("text")}>
            <Download className="size-4" /> Text summary
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Duration</CardTitle>
          <CardDescription>
            The current term (term {currentTerm.index}) is {monthsLabel(record.durationMonths)}, from {formatUTC(currentTerm.startedAt)}. Changing it
            moves only this term&apos;s end. Type the current end date ({endDate}) to confirm.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Select
              value={durationChoice}
              onValueChange={(v) => setDurationChoice(v ?? String(record.durationMonths))}
              items={{ ...Object.fromEntries(DURATION_PRESETS.map((m) => [String(m), monthsLabel(m)])), custom: "Custom" }}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DURATION_PRESETS.map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {monthsLabel(m)}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
            {durationChoice === "custom" && (
              <Input
                className="w-28"
                type="number"
                min={1}
                max={60}
                step={1}
                placeholder="1 to 60"
                value={customMonths}
                onChange={(e) => setCustomMonths(e.target.value)}
              />
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {!monthsValid
              ? "Choose a whole number of months from 1 to 60."
              : chosenMonths === record.durationMonths
                ? `This is the current duration. The term ends ${formatUTC(record.endsAt)}.`
                : `New end: ${formatUTC(previewEnd!)}${new Date(previewEnd!).getTime() <= new Date(now).getTime() ? " (the term would be Ended)" : ""}.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              className="w-40"
              placeholder="YYYY-MM-DD"
              value={typedDurationEnd}
              onChange={(e) => setTypedDurationEnd(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!monthsValid || chosenMonths === record.durationMonths || typedDurationEnd !== endDate || changeDuration.isPending}
              onClick={() =>
                changeDuration.mutate(
                  { months: chosenMonths, confirmEndDate: typedDurationEnd },
                  { onSuccess: () => setTypedDurationEnd("") }
                )
              }
            >
              {changeDuration.isPending && <Loader2 className="size-4 animate-spin" />}
              Change duration
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Renewal</CardTitle>
          <CardDescription>
            {d.remainingMs > 0
              ? `Adds a term from ${formatUTC(record.endsAt)} to ${monthsLabel(record.durationMonths)} later.`
              : `Adds a term from now to ${monthsLabel(record.durationMonths)} from now.`}{" "}
            Type the current end date ({endDate}) to confirm.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Input className="w-40" placeholder="YYYY-MM-DD" value={typedEnd} onChange={(e) => setTypedEnd(e.target.value)} />
          <Button
            size="sm"
            disabled={typedEnd !== endDate || renew.isPending}
            onClick={() => renew.mutate(typedEnd, { onSuccess: () => setTypedEnd("") })}
          >
            {renew.isPending && <Loader2 className="size-4 animate-spin" />}
            Add {monthsLabel(record.durationMonths)}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

export function SubscriptionServerPage({ serverId }: { serverId: string }) {
  const { user } = useAuth()
  const isSuperAdmin = user?.role === "SUPER_ADMIN"
  const { data, isLoading, isError, refetch } = useServerSubscription(serverId, isSuperAdmin)
  const { data: clock } = useServerSubscriptionClock(serverId, isSuperAdmin && !!data?.record)
  const record = data?.record ?? null
  const endsAtChanged = !!record && !!clock?.endsAt && clock.endsAt !== record.endsAt

  useEffect(() => {
    if (endsAtChanged) void refetch()
  }, [endsAtChanged, refetch])

  if (!isSuperAdmin) return null

  const live = record && clock?.endsAt === record.endsAt ? clock.now : data?.now
  const server = data?.server ?? null

  return (
    <div className="space-y-6">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="mb-2 -ml-2 text-muted-foreground"
          render={
            <Link href="/subscription">
              <ArrowLeft className="size-4" /> Subscription
            </Link>
          }
        />
        <PageHeader title={server?.name ?? "Subscription"} description={server?.organizationName ?? undefined} />
      </div>
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError && !data ? (
        <EmptyState icon={CalendarClock} title="Server not found" description="It may have been removed, or the subscription data is unavailable." />
      ) : !server ? null : !record || !live ? (
        <EmptyState icon={CalendarClock} title="Not started" description="This server's subscription term starts on its first venue connection." />
      ) : (
        <Content server={server} record={record} now={live} />
      )}
    </div>
  )
}
