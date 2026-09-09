/** Simulated network latency so loading states / skeletons are visible and
 * meaningful during development, matching what a real REST call over the
 * internet to a Windows MusicServer's cloud session would feel like. */
export function delay(ms = 350): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function jitter(base = 300, spread = 250): number {
  return base + Math.random() * spread
}
