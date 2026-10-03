// Replay protection: reject duplicate IDs and envelopes outside the time window.

export interface ReplayGuardOptions {
  maxAgeMs: number
  maxSkewMs?: number
  maxEntries?: number
}

export class ReplayGuard {
  private readonly seen = new Map<string, number>()
  private readonly maxAgeMs: number
  private readonly maxSkewMs: number
  private readonly maxEntries: number

  constructor(opts: ReplayGuardOptions) {
    this.maxAgeMs = opts.maxAgeMs
    this.maxSkewMs = opts.maxSkewMs ?? 30_000
    this.maxEntries = opts.maxEntries ?? 10_000
  }

  get size(): number {
    return this.seen.size
  }

  /** Returns true if the envelope is new and fresh, and records it. */
  check(env: { id: string; ts: number }, now: number = Date.now()): boolean {
    this.prune(now)
    if (env.ts < now - this.maxAgeMs || env.ts > now + this.maxSkewMs) return false
    if (this.seen.has(env.id)) return false
    this.seen.set(env.id, env.ts)
    // Evict oldest insertions under a flood. An evicted id is at worst replayable
    // within its age window, which a flood of valid encrypted frames requires the key for.
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
    return true
  }

  private prune(now: number): void {
    const cutoff = now - this.maxAgeMs
    for (const [id, ts] of this.seen) if (ts < cutoff) this.seen.delete(id)
  }
}
