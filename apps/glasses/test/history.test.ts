// A session's history envelope fills the timeline of a phone that opens late.
import { describe, expect, test } from 'bun:test'
import type { HistoryItem } from '@g2cc/protocol'
import { buildTimeline } from '../src/timeline'
import { view } from '../src/state'
import { env, frame, gs, NOW, paired, recv } from './helpers'

const OLD = NOW - 3_600_000
const items: HistoryItem[] = [
  { id: 'p1', ts: OLD, kind: 'event', body: { type: 'prompt', summary: 'run the tests' } },
  { id: 't1', ts: OLD + 1, kind: 'event', body: { type: 'tool_start', tool: 'Bash', summary: 'bun test' } },
  { id: 't1e', ts: OLD + 2, kind: 'event', body: { type: 'tool_end', tool: 'Bash', summary: 'ok' } },
  { id: 'r1', ts: OLD + 3, kind: 'reply', body: { text: 'All **42** tests pass.' } },
  { id: 'g1', ts: OLD + 4, kind: 'glance', body: { text: 'Tests pass' } },
]
const lines = (s: ReturnType<typeof paired>) => buildTimeline(view(s).entries).lines

describe('session history', () => {
  test('an empty timeline is filled in, as old activity (no toasts, stays live)', () => {
    const s = recv(paired(), env('history', { items }))
    expect(lines(s)).toEqual(['> run the tests', '• Bash: bun test → ok', '', 'All 42 tests pass.', '', '» Tests pass'])
    expect(view(s).fromBottom).toBe(0)
    expect(s.toast).toBeUndefined()
    expect(frame(s).timeline).toContain('All 42 tests pass.')
  })

  test('entries the view already has appear once, and newer live ones stay after the history', () => {
    let s = paired()
    // The relay still had two of them, and something newer arrived live.
    s = recv(s, { ...env('event', items[0]!.body as never), id: 'p1', ts: OLD })
    s = recv(s, { ...env('event', items[1]!.body as never), id: 't1', ts: OLD + 1 })
    s = recv(s, env('event', { type: 'notify', summary: 'later' }, NOW))
    s = recv(s, env('history', { items: items.slice(0, 4) }, NOW - 10))
    expect(lines(s)).toEqual(['> run the tests', '• Bash: bun test → ok', '', 'All 42 tests pass.', '', '! later'])
  })

  test('an older history replayed by the relay after a newer one changes nothing', () => {
    const s = recv(paired(), env('history', { items }, NOW))
    const t = recv(s, env('history', { items: items.slice(0, 1) }, NOW - 60_000))
    expect(view(t).entries).toEqual(view(s).entries)
  })

  test('a replayed live envelope, after the history has it, is not added twice', () => {
    let s = recv(paired(), env('history', { items }))
    s = recv(s, { ...env('event', items[2]!.body as never), id: 't1e', ts: OLD + 2 })
    s = recv(s, { ...env('reply', { text: 'All **42** tests pass.' }), id: 'r1', ts: OLD + 3 })
    s = recv(s, { ...env('glance', { text: 'Tests pass' }), id: 'g1', ts: OLD + 4 })
    expect(lines(s)).toEqual(['> run the tests', '• Bash: bun test → ok', '', 'All 42 tests pass.', '', '» Tests pass'])
  })

  test('history is scrollable without new activity', () => {
    const many: HistoryItem[] = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, ts: OLD + i, kind: 'event', body: { type: 'notify', summary: `note ${i}` } }))
    const s = gs(recv(paired(), env('history', { items: many })), 'scroll_up')
    expect(view(s).fromBottom).toBeGreaterThan(0)
    expect(frame(s).timeline.split('\n')[0]).toBe('! note 18')
  })

  test('a scrolled view keeps its place when history arrives', () => {
    const many: HistoryItem[] = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, ts: OLD + i, kind: 'event', body: { type: 'notify', summary: `note ${i}` } }))
    let s = recv(paired(), env('history', { items: many.slice(10) }, NOW - 5))
    s = gs(s, 'scroll_up')
    const before = view(s).fromBottom
    s = recv(s, env('history', { items: many }, NOW))
    expect(view(s).fromBottom).toBe(before)
    expect(view(s).entries.length).toBe(30)
  })
})
