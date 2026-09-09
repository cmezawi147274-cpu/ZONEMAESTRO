/**
 * Superseded — the real Windows MusicServer agent integration (pairing,
 * heartbeats, command dispatch/ack, track/zone/schedule sync,
 * MusicServerHub) is implemented in:
 *   - ../routes/agent.ts        (the agent-facing REST surface)
 *   - ../agent/signalrHub.ts    (the SignalR-compatible push channel)
 *   - ../lib/agent-auth.ts, ../lib/agent-registry.ts, ../lib/pairing.ts,
 *     ../lib/zone-effects.ts, ../lib/agent-sweep.ts
 *
 * This file is kept only so an old relative import doesn't 404; nothing
 * in the app imports it anymore.
 */
export {}
