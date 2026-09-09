import type { Metadata } from "next"

export const metadata: Metadata = {
  title: {
    absolute: "ZoneMaestro",
  },
  description:
    "Sign in to ZoneMaestro to manage organizations, music, and connected MusicServers.",
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children
}
