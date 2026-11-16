"use client"

import { useEffect } from "react"
import { apiClient } from "@/lib/api/client"
import { isMockMode } from "@/lib/config"

export function usePushRegistration(enabled: boolean) {
  useEffect(() => {
    const bridge = (window as { ReactNativeWebView?: { postMessage(message: string): void } }).ReactNativeWebView
    if (!enabled || isMockMode || !bridge) return
    const onToken = (event: Event) => {
      const { token, platform } = (event as CustomEvent<{ token: string; platform: string }>).detail
      apiClient.post("/push/devices", { token, platform }).catch(() => {})
    }
    window.addEventListener("zm-push-token", onToken)
    bridge.postMessage(JSON.stringify({ type: "push-token-request" }))
    return () => window.removeEventListener("zm-push-token", onToken)
  }, [enabled])
}
