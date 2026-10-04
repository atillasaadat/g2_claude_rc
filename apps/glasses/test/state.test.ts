import { describe, expect, test } from 'bun:test'
import { DEFAULT_GESTURES } from '../src/gestures'
import { TIMELINE_LINES } from '../src/layout'
import { initialState, isAnimating, reduce, SCROLL_STEP, totalLines, type AppState } from '../src/state'
import { view } from '../src/state'
import { env, g, gs, NOW, paired, recv, withLines } from './helpers'

describe('timeline: envelopes', () => {
  test('session updates the header info; older replays never clobber newer state', () => {
    let s = paired()
    s = recv(s, env('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'working' }, NOW + 10))
    s = recv(s, env('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'idle' }, NOW + 5))
    expect(view(s).session?.state).toBe('working')
  })

  test('tool_end merges into its tool_start, so each tool call is one line', () => {
    let s = recv(paired(), env('event', { type: 'tool_start', tool: 'Bash', summary: 'ls' }))
    s = recv(s, env('event', { type: 'tool_end', tool: 'Bash', summary: 'ok' }))
    expect(view(s).entries).toHaveLength(1)
    expect(view(s).entries[0]).toMatchObject({ kind: 'tool', tool: 'Bash', text: 'ls', result: 'ok' })
  })

  test('glances and replies join the timeline; replies become plain text', () => {
    let s = recv(paired(), env('glance', { text: 'All green' }))
    s = recv(s, env('reply', { text: '**Done.** Ran `bun test`.' }))
    expect(view(s).entries.map(e => [e.kind, e.text])).toEqual([
      ['glance', 'All green'],
      ['reply', 'Done. Ran bun test.'],
    ])
  })

  test('keeps at most 80 entries and does not mutate the previous state', () => {
    const s0 = paired()
    const s = withLines(s0, 100)
    expect(view(s).entries).toHaveLength(80)
    expect(view(s0).entries).toHaveLength(0)
  })
})

describe('timeline: scrolling', () => {
  test('swipe up scrolls back by SCROLL_STEP, swipe down returns, both clamped', () => {
    const s = withLines(paired(), 30)
    const up = gs(s, 'scroll_up')
    expect(view(up).fromBottom).toBe(SCROLL_STEP)
    expect(view(gs(up, 'scroll_down')).fromBottom).toBe(0)
    expect(view(gs(s, 'scroll_down')).fromBottom).toBe(0)
    const top = gs(s, ...Array(30).fill('scroll_up'))
    expect(view(top).fromBottom).toBe(totalLines(view(s).entries) - TIMELINE_LINES)
  })

  test('no scrolling when everything fits', () => {
    expect(view(gs(withLines(paired(), 3), 'scroll_up')).fromBottom).toBe(0)
  })

  test('new lines keep a scrolled-up view steady, and follow live at the bottom', () => {
    const s = gs(withLines(paired(), 30), 'scroll_up')
    const more = withLines(s, 2)
    expect(view(more).fromBottom).toBe(SCROLL_STEP + 2)
    expect(view(withLines(withLines(paired(), 30), 2)).fromBottom).toBe(0)
  })

  test('double tap jumps back to live and never exits', () => {
    const scrolled = gs(withLines(paired(), 30), 'scroll_up', 'scroll_up')
    const r = g(scrolled, 'double_tap')
    expect(view(r.state).fromBottom).toBe(0)
    expect(r.effects).toEqual([])
    expect(g(r.state, 'double_tap').effects).toEqual([])
  })

  test('End session asks first, starting on Cancel, and Unpair phone forgets everything', () => {
    const base = recv(withLines(paired(), 3), env('session', { name: 'repo', cwd: '/r', state: 'idle' }))
    const asking = gs(base, 'tap', 'scroll_down', 'scroll_down', 'tap')
    expect(asking.confirmEnd).toBe(true)
    expect(asking.menuIndex).toBe(0)
    // Cancel (the default) closes the menu and keeps the pairing.
    const kept = g(asking, 'tap')
    expect([kept.effects, kept.state.screen, kept.state.paired]).toEqual([[], 'timeline', true])
    // Unpair phone asks main to forget the pairing...
    const gone = g(gs(asking, 'scroll_down'), 'tap')
    expect(gone.effects).toEqual([{ type: 'unpair' }])
    // ...and once it has, no session, card or question is left.
    const after = reduce(gone.state, { type: 'paired', paired: false }).state
    expect([after.paired, Object.keys(after.views), after.cards, after.questions]).toEqual([false, [], [], []])
    // Reopening the menu starts fresh, not on the question.
    expect(gs(asking, 'double_tap', 'tap').confirmEnd).toBe(false)
  })

  test('a fresh long reply lands on its first line; a short one stays at the bottom', () => {
    const long = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join('\n')
    let s = recv(withLines(paired(), 5), env('event', { type: 'prompt', summary: 'go', origin: 'local' }))
    s = recv(s, env('reply', { text: long }))
    expect(view(s).fromBottom).toBe(20 - TIMELINE_LINES)
    expect(view(recv(paired(), env('reply', { text: 'Short.' }))).fromBottom).toBe(0)
  })

  test('a replayed old reply does not move the view; neither does a reply while scrolled', () => {
    const long = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join('\n')
    expect(view(recv(paired(), env('reply', { text: long }, NOW - 10 * 60_000))).fromBottom).toBe(0)
    const scrolled = gs(withLines(paired(), 30), 'scroll_up')
    const after = recv(scrolled, env('reply', { text: long }))
    expect(view(after).fromBottom).toBeGreaterThan(SCROLL_STEP) // kept the same lines in view
  })

  test('a fresh prompt returns to live from a scrolled timeline', () => {
    const scrolled = gs(withLines(paired(), 30), 'scroll_up')
    expect(view(recv(scrolled, env('event', { type: 'prompt', summary: 'next', origin: 'local' }))).fromBottom).toBe(0)
  })
})

describe('menu and stop', () => {
  const working = () => recv(paired(), env('session', { name: 'r', cwd: '/r', state: 'working' }, NOW + 1))

  test('tap opens the menu; scroll moves within bounds; double tap closes', () => {
    let s = gs(working(), 'tap')
    expect(s.screen).toBe('menu')
    s = gs(s, 'scroll_down', 'scroll_down', 'scroll_down')
    expect(s.menuIndex).toBe(2)
    expect(gs(s, 'double_tap').screen).toBe('timeline')
  })

  test('Stop Claude sends stop and marks stopping until the session settles', () => {
    const r = g(gs(working(), 'tap', 'scroll_down'), 'tap')
    expect(r.effects).toEqual([{ type: 'send', kind: 'stop', body: {}, sid: '' }])
    expect(view(r.state).stopPending).toBe(true)
    expect(view(recv(r.state, env('session', { name: 'r', cwd: '/r', state: 'working' }, NOW + 2))).stopPending).toBe(true)
    expect(view(recv(r.state, env('session', { name: 'r', cwd: '/r', state: 'stopped' }, NOW + 2))).stopPending).toBe(false)
  })

  test('Talk without a Groq key does nothing', () => {
    const s = gs({ ...working(), voiceAvailable: false }, 'tap', 'tap')
    expect(s.screen).toBe('menu')
  })
})

describe('connection and animation', () => {
  test('link follows relay status and computer presence', () => {
    let s: AppState = reduce(initialState(), { type: 'relay', status: 'open' }).state
    expect(s.link).toBe('relay')
    s = reduce(s, { type: 'presence', computers: 1 }).state
    expect(s.link).toBe('online')
    expect(reduce(s, { type: 'relay', status: 'closed' }).state.link).toBe('offline')
  })

  test('animates only while working, stopping, recording, or fading', () => {
    expect(isAnimating(paired())).toBe(false)
    expect(isAnimating(recv(paired(), env('session', { name: 'r', cwd: '/r', state: 'working' }, NOW + 1)))).toBe(true)
    const menu = reduce(paired(), { type: 'gesture', gesture: 'tap', map: DEFAULT_GESTURES, now: 1000 }).state
    expect(isAnimating(menu)).toBe(true) // fading in
    expect(isAnimating(reduce(menu, { type: 'tick', now: 5000 }).state)).toBe(false)
  })
})
