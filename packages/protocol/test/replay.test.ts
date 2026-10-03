import { describe, expect, test } from 'bun:test'
import { ReplayGuard } from '../src/replay'

const env = (id: string, ts: number) => ({ id, ts })

describe('ReplayGuard', () => {
  test('accepts a fresh envelope once, then rejects the duplicate', () => {
    const g = new ReplayGuard({ maxAgeMs: 60_000 })
    const now = 1_000_000
    expect(g.check(env('a', now), now)).toBe(true)
    expect(g.check(env('a', now), now)).toBe(false)
  })

  test('rejects envelopes older than maxAge', () => {
    const g = new ReplayGuard({ maxAgeMs: 60_000 })
    const now = 1_000_000
    expect(g.check(env('old', now - 60_001), now)).toBe(false)
    expect(g.check(env('edge', now - 60_000), now)).toBe(true)
  })

  test('rejects envelopes too far in the future', () => {
    const g = new ReplayGuard({ maxAgeMs: 60_000, maxSkewMs: 5_000 })
    const now = 1_000_000
    expect(g.check(env('f', now + 5_001), now)).toBe(false)
    expect(g.check(env('ok', now + 4_000), now)).toBe(true)
  })

  test('forgets ids once they could no longer pass the age check', () => {
    const g = new ReplayGuard({ maxAgeMs: 1_000, maxSkewMs: 0 })
    expect(g.check(env('a', 0), 0)).toBe(true)
    g.check(env('b', 5_000), 5_000)
    expect(g.size).toBe(1)
    // 'a' is now too old regardless, so forgetting it is safe.
    expect(g.check(env('a', 0), 5_000)).toBe(false)
  })

  test('caps memory under a flood of unique ids', () => {
    const g = new ReplayGuard({ maxAgeMs: 60_000, maxEntries: 100 })
    for (let i = 0; i < 1_000; i++) g.check(env(`id${i}`, 1_000), 1_000)
    expect(g.size).toBeLessThanOrEqual(100)
  })
})
