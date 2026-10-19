"use client"

import { use } from "react"
import { SubscriptionServerPage } from "@/components/subscription/server-page"

export default function Page({ params }: { params: Promise<{ serverId: string }> }) {
  const { serverId } = use(params)
  return <SubscriptionServerPage serverId={decodeURIComponent(serverId)} />
}
