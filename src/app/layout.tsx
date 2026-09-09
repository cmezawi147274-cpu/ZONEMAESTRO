import type { Metadata } from "next";
import { Geist, Geist_Mono, Montserrat } from "next/font/google";
import { Providers } from "@/app/providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/** The brand face. The login screen is typeset entirely in it (the design
 * reference calls it `--font-logo`); the rest of the app stays on Geist, so
 * this is exposed as a variable rather than applied to <body>. */
const montserrat = Montserrat({
  variable: "--font-logo",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: {
    default: "ZoneMaestro",
    template: "%s · ZoneMaestro",
  },
  description:
    "Cloud-based management portal for multi-zone commercial music distribution — manage the cloud music library, synchronize to Windows MusicServers, and monitor zones in real time.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${montserrat.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
