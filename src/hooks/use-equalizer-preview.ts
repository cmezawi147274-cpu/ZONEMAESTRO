"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { EQ_BANDS } from "@/lib/equalizer/presets"
import type { ZoneEqualizerSettings } from "@/lib/api/types"

/**
 * A genuinely audible, in-browser audition of a zone's equalizer curve.
 *
 * There is nothing to preview *of the venue* here — the physical
 * MusicServer has no DSP of its own (see the Zone.equalizer doc comment in
 * backend/prisma/schema.prisma), so this runs entirely client-side against
 * a self-generated pink-noise loop, which is the standard reference signal
 * for auditioning an EQ curve by ear. It is not a stand-in for real zone
 * audio and never claims to be — it's how an operator can hear what a
 * curve *does* before it ever reaches hardware that supports it.
 *
 * Starts only on an explicit call to `toggle()` from a click handler (never
 * on mount / on settings change) so it never fights the browser's autoplay
 * policy. While playing, filter params track `settings` live — dragging a
 * band is audible immediately, not just at the next play.
 */
export function useEqualizerPreview(settings: ZoneEqualizerSettings) {
  const [isPlaying, setIsPlaying] = useState(false)
  const ctxRef = useRef<AudioContext | null>(null)
  const nodesRef = useRef<{
    source: AudioBufferSourceNode
    bands: BiquadFilterNode[]
    bassShelf: BiquadFilterNode
    loudLow: BiquadFilterNode
    loudHigh: BiquadFilterNode
    splitter: ChannelSplitterNode
    widenDelay: DelayNode
    merger: ChannelMergerNode
    master: GainNode
  } | null>(null)

  /** One period of pink noise (Voss-McCartney-ish running-sum approximation),
   * looped — a flat-ish source is what makes the curve's shape audible,
   * unlike music where the program material masks it. */
  const pinkNoiseBuffer = useCallback((ctx: AudioContext) => {
    const seconds = 4
    const buffer = ctx.createBuffer(2, ctx.sampleRate * seconds, ctx.sampleRate)
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel)
      let b0 = 0,
        b1 = 0,
        b2 = 0
      for (let i = 0; i < data.length; i++) {
        const white = Math.random() * 2 - 1
        b0 = 0.99765 * b0 + white * 0.099
        b1 = 0.963 * b1 + white * 0.2965
        b2 = 0.57 * b2 + white * 1.0526
        data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.11
      }
    }
    return buffer
  }, [])

  const applySettings = useCallback((s: ZoneEqualizerSettings) => {
    const nodes = nodesRef.current
    if (!nodes) return
    const t = nodes.master.context.currentTime
    const RAMP = 0.05

    EQ_BANDS.forEach((_, i) => {
      const gain = s.enabled ? (s.bands[i] ?? 0) : 0
      nodes.bands[i].gain.linearRampToValueAtTime(gain, t + RAMP)
    })

    const bassGain = s.enabled && s.bassBoost.on ? (s.bassBoost.amount / 100) * 9 : 0
    nodes.bassShelf.gain.linearRampToValueAtTime(bassGain, t + RAMP)

    // Loudness: a gentle low+high shelf lift, the classic "sounds fuller at
    // low listening levels" compensation curve, scaled by amount.
    const loudGain = s.enabled && s.loudness.on ? (s.loudness.amount / 100) * 6 : 0
    nodes.loudLow.gain.linearRampToValueAtTime(loudGain, t + RAMP)
    nodes.loudHigh.gain.linearRampToValueAtTime(loudGain * 0.7, t + RAMP)

    // Virtualizer: a simple stereo widener — delay one channel a few
    // milliseconds against the other. An approximation, not a claim of any
    // particular proprietary algorithm.
    const widen = s.enabled && s.virtualizer.on ? (s.virtualizer.amount / 100) * 0.02 : 0
    nodes.widenDelay.delayTime.linearRampToValueAtTime(widen, t + RAMP)
  }, [])

  useEffect(() => {
    if (isPlaying) applySettings(settings)
  }, [settings, isPlaying, applySettings])

  const stop = useCallback(() => {
    const nodes = nodesRef.current
    if (nodes) {
      try {
        nodes.source.stop()
      } catch {
        /* already stopped */
      }
      nodes.source.disconnect()
      nodes.master.disconnect()
    }
    nodesRef.current = null
    setIsPlaying(false)
  }, [])

  const start = useCallback(() => {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    if (!ctxRef.current) ctxRef.current = new Ctor()
    const ctx = ctxRef.current
    if (ctx.state === "suspended") void ctx.resume()

    const source = ctx.createBufferSource()
    source.buffer = pinkNoiseBuffer(ctx)
    source.loop = true

    const bands = EQ_BANDS.map((hz) => {
      const f = ctx.createBiquadFilter()
      f.type = "peaking"
      f.frequency.value = hz
      f.Q.value = 1
      f.gain.value = 0
      return f
    })
    const bassShelf = ctx.createBiquadFilter()
    bassShelf.type = "lowshelf"
    bassShelf.frequency.value = 100
    bassShelf.gain.value = 0

    const loudLow = ctx.createBiquadFilter()
    loudLow.type = "lowshelf"
    loudLow.frequency.value = 150
    loudLow.gain.value = 0
    const loudHigh = ctx.createBiquadFilter()
    loudHigh.type = "highshelf"
    loudHigh.frequency.value = 8000
    loudHigh.gain.value = 0

    const splitter = ctx.createChannelSplitter(2)
    const widenDelay = ctx.createDelay(0.05)
    const merger = ctx.createChannelMerger(2)
    const master = ctx.createGain()
    master.gain.value = 0.5

    // Chain: source -> 10 peaking bands -> bass shelf -> loudness shelves
    // -> [splitter -> (L passthrough / R delayed) -> merger] -> master.
    let node: AudioNode = source
    for (const b of bands) {
      node.connect(b)
      node = b
    }
    node.connect(bassShelf)
    bassShelf.connect(loudLow)
    loudLow.connect(loudHigh)
    loudHigh.connect(splitter)
    splitter.connect(merger, 0, 0)
    splitter.connect(widenDelay, 1)
    widenDelay.connect(merger, 0, 1)
    merger.connect(master)
    master.connect(ctx.destination)

    nodesRef.current = { source, bands, bassShelf, loudLow, loudHigh, splitter, widenDelay, merger, master }
    source.start()
    // Gains start at 0 (flat) above; the effect keyed on [settings,
    // isPlaying] applies the real curve the instant `isPlaying` flips
    // true, a moment from now — no ref needed to reach for a "latest
    // settings" here too.
    setIsPlaying(true)
  }, [pinkNoiseBuffer])

  const toggle = useCallback(() => {
    if (isPlaying) stop()
    else start()
  }, [isPlaying, start, stop])

  useEffect(() => stop, [stop])

  return { isPlaying, toggle }
}
