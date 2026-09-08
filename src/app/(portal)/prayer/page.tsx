"use client"

import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { PrayerModeForm } from "@/components/prayer/prayer-mode-form"
import { ZoneParticipationList } from "@/components/prayer/zone-participation-list"
import { useAuth } from "@/hooks/use-auth"
import { Moon } from "lucide-react"

export default function PrayerModePage() {
  const { can } = useAuth()

  if (!can("prayer:read")) {
    return <EmptyState icon={Moon} title="You don't have access to Prayer Mode" />
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Prayer Mode"
        description="Automatically pause eligible zones for Fajr, Dhuhr, Asr, Maghrib and Isha, calculated for your location."
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <PrayerModeForm />
        </div>
        <div>
          <ZoneParticipationList />
        </div>
      </div>
    </div>
  )
}
