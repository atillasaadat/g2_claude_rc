import { describe, expect, test } from 'bun:test'
import { makeEnvelope, type AnyEnvelope, type Body, type Kind } from '@g2cc/protocol'
import { DEFAULT_GESTURES } from '../src/gestures'
import { initialState, reduce, type AppState } from '../src/state'

const NOW = 1_800_000_000_000
const env = <K extends Kind>(kind: K, body: Body<K>, ts = NOW): AnyEnvelope => ({ ...makeEnvelope(kind, body), ts }) as AnyEnvelope
const recv = (s: AppState, e: AnyEnvelope, now = NOW) => reduce(s, { type: 'envelope', env: e, now })
const gesture = (s: AppState, g: 'tap' | 'double_tap' | 'scroll_up' | 'scroll_down') =>
  reduce(s, { type: 'gesture', gesture: g, map: DEFAULT_GESTURES }).state

describe('reduce: envelopes', () => {
  test('session updates the header info', () => {
    const s = recv(initialState(), env('session', { name: 'repo', cwd: '/r', state: 'working', mode: 'auto' })).state
    expect(s.session).toEqual({ name: 'repo', cwd: '/r', state: 'working', mode: 'auto' })
  })

  test('tool_end merges into the matching tool_start line', () => {
    let s = initialState()
    s = recv(s, env('event', { type: 'tool_start', tool: 'Bash', summary: 'ls' })).state
    s = recv(s, env('event', { type: 'tool_end', tool: 'Bash', summary: 'ok' })).state
    expect(s.events).toHaveLength(1)
    expect(s.events[0]).toMatchObject({ type: 'tool', tool: 'Bash', summary: 'ls', result: 'ok' })
  })

  test('tool_end without a pending start becomes its own line', () => {
    const s = recv(initialState(), env('event', { type: 'tool_end', tool: 'Read', summary: 'done' })).state
    expect(s.events[0]).toMatchObject({ type: 'tool', tool: 'Read', result: 'done' })
  })

  test('keeps at most 50 events', () => {
    let s = initialState()
    for (let i = 0; i < 60; i++) s = recv(s, env('event', { type: 'notify', summary: `n${i}` })).state
    expect(s.events).toHaveLength(50)
    expect(s.events.at(-1)!.summary).toBe('n59')
  })

  test('a fresh reply opens the reply screen', () => {
    const s = recv(initialState(), env('reply', { text: 'done' })).state
    expect(s.reply?.text).toBe('done')
    expect(s.screen).toBe('reply')
    expect(s.replyPage).toBe(0)
  })

  test('an old reply from history is stored but does not take over the screen', () => {
    const s = recv(initialState(), env('reply', { text: 'old' }, NOW - 5 * 60_000)).state
    expect(s.reply?.text).toBe('old')
    expect(s.screen).toBe('feed')
  })

  test('glance is stored', () => {
    expect(recv(initialState(), env('glance', { text: 'All green' })).state.glance).toBe('All green')
  })

  test('history replays older envelopes out of order without clobbering newer state', () => {
    let s = recv(initialState(), env('session', { name: 'repo', cwd: '/r', state: 'idle' }, NOW))
      .state
    s = recv(s, env('session', { name: 'repo', cwd: '/r', state: 'working' }, NOW - 1000)).state
    expect(s.session?.state).toBe('idle')
  })

  test('does not mutate the previous state', () => {
    const s0 = initialState()
    recv(s0, env('event', { type: 'notify', summary: 'x' }))
    expect(s0.events).toHaveLength(0)
  })
})

describe('reduce: connection', () => {
  test('tracks relay status and computer presence', () => {
    let s = reduce(initialState(), { type: 'relay', status: 'open' }).state
    expect(s.link).toBe('relay')
    s = reduce(s, { type: 'presence', computers: 1 }).state
    expect(s.link).toBe('online')
    s = reduce(s, { type: 'presence', computers: 0 }).state
    expect(s.link).toBe('relay')
    s = reduce(s, { type: 'relay', status: 'closed' }).state
    expect(s.link).toBe('offline')
  })
})

describe('reduce: gestures', () => {
  const withEvents = (n: number) => {
    let s = initialState()
    for (let i = 0; i < n; i++) s = recv(s, env('event', { type: 'notify', summary: `n${i}` })).state
    return s
  }

  test('feed scroll up shows older events, scroll down returns', () => {
    let s = withEvents(10)
    s = gesture(s, 'scroll_up')
    expect(s.feedOffset).toBe(1)
    s = gesture(gesture(s, 'scroll_up'), 'scroll_down')
    expect(s.feedOffset).toBe(1)
  })

  test('feed scroll up stops at the oldest page', () => {
    let s = withEvents(5)
    for (let i = 0; i < 10; i++) s = gesture(s, 'scroll_up')
    expect(s.feedOffset).toBe(1) // 5 events, 4 visible
  })

  test('scroll down at the newest events opens the last reply', () => {
    let s = recv(withEvents(3), env('reply', { text: 'r' }, NOW - 10 * 60_000)).state
    expect(s.screen).toBe('feed')
    s = gesture(s, 'scroll_down')
    expect(s.screen).toBe('reply')
  })

  test('scroll down at the newest events without a reply does nothing', () => {
    const s = gesture(withEvents(3), 'scroll_down')
    expect(s.screen).toBe('feed')
  })

  test('reply pages and goes back', () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    let s = recv(initialState(), env('reply', { text: long })).state
    s = gesture(s, 'scroll_down')
    expect(s.replyPage).toBe(1)
    s = gesture(s, 'scroll_up')
    s = gesture(s, 'scroll_up')
    expect(s.replyPage).toBe(0)
    for (let i = 0; i < 10; i++) s = gesture(s, 'scroll_down')
    expect(s.replyPage).toBe(3) // 30 lines / 9 per page = 4 pages
    s = gesture(s, 'double_tap')
    expect(s.screen).toBe('feed')
  })

  test('double tap on the feed asks to exit', () => {
    const r = reduce(initialState(), { type: 'gesture', gesture: 'double_tap', map: DEFAULT_GESTURES })
    expect(r.effects).toEqual([{ type: 'exit' }])
  })

  test('voice.start is a no-op until Phase 6', () => {
    const map = { ...DEFAULT_GESTURES, feed: { ...DEFAULT_GESTURES.feed, tap: 'voice.start' as const } }
    const r = reduce(initialState(), { type: 'gesture', gesture: 'tap', map })
    expect(r.state.screen).toBe('feed')
    expect(r.effects).toEqual([])
  })
})

describe('reduce: new turns', () => {
  test('a fresh prompt brings the reply view back to the newest feed', () => {
    let s = recv(initialState(), env('reply', { text: 'previous answer' })).state
    expect(s.screen).toBe('reply')
    s = { ...s, feedOffset: 3 }
    s = recv(s, env('event', { type: 'prompt', summary: 'next task', origin: 'local' })).state
    expect(s.screen).toBe('feed')
    expect(s.feedOffset).toBe(0)
  })

  test('a replayed old prompt does not leave the reply view', () => {
    let s = recv(initialState(), env('reply', { text: 'answer' })).state
    s = recv(s, env('event', { type: 'prompt', summary: 'old', origin: 'local' }, NOW - 10 * 60_000)).state
    expect(s.screen).toBe('reply')
  })

  test('replies are shown as plain text', () => {
    const s = recv(initialState(), env('reply', { text: '**Done.** Ran `bun test`.' })).state
    expect(s.reply?.pages[0]).toBe('Done. Ran bun test.')
  })
})

describe('reduce: menu and stop', () => {
  const working = () => recv(initialState(), env('session', { name: 'repo', cwd: '/r', state: 'working' })).state
  const g = (s: AppState, gest: 'tap' | 'double_tap' | 'scroll_up' | 'scroll_down') =>
    reduce(s, { type: 'gesture', gesture: gest, map: DEFAULT_GESTURES })

  test('feed tap opens the menu with Talk highlighted', () => {
    const s = g(working(), 'tap').state
    expect(s.screen).toBe('menu')
    expect(s.menuIndex).toBe(0)
  })

  test('menu scroll moves the highlight within bounds, double tap goes back', () => {
    let s = g(working(), 'tap').state
    s = g(s, 'scroll_down').state
    expect(s.menuIndex).toBe(1)
    s = g(s, 'scroll_down').state
    expect(s.menuIndex).toBe(1)
    s = g(s, 'scroll_up').state
    s = g(s, 'scroll_up').state
    expect(s.menuIndex).toBe(0)
    expect(g(s, 'double_tap').state.screen).toBe('feed')
  })

  test('choosing Stop sends stop, returns to the feed, and marks stopping', () => {
    let s = g(working(), 'tap').state
    s = g(s, 'scroll_down').state
    const r = g(s, 'tap')
    expect(r.effects).toEqual([{ type: 'send', kind: 'stop', body: {} }])
    expect(r.state.screen).toBe('feed')
    expect(r.state.stopPending).toBe(true)
  })

  test('choosing Talk does nothing without a Groq key', () => {
    const r = g(g(working(), 'tap').state, 'tap')
    expect(r.effects).toEqual([])
    expect(r.state.screen).toBe('menu')
  })

  test('stopping clears once the session is stopped or idle', () => {
    let s: AppState = { ...working(), stopPending: true }
    s = recv(s, env('session', { name: 'repo', cwd: '/r', state: 'working' }, NOW + 1)).state
    expect(s.stopPending).toBe(true)
    s = recv(s, env('session', { name: 'repo', cwd: '/r', state: 'stopped' }, NOW + 2)).state
    expect(s.stopPending).toBe(false)
    s = { ...s, stopPending: true }
    s = recv(s, env('session', { name: 'repo', cwd: '/r', state: 'idle' }, NOW + 3)).state
    expect(s.stopPending).toBe(false)
  })

  test('a fresh prompt clears stopping', () => {
    let s: AppState = { ...working(), stopPending: true }
    s = recv(s, env('event', { type: 'prompt', summary: 'next', origin: 'local' })).state
    expect(s.stopPending).toBe(false)
  })
})
