import { describe, expect, test } from 'bun:test'
import { DEFAULT_GESTURES, parseGestureMap } from '../src/gestures'
import { reduce, VOICE_REVIEW_LINES, voiceLineCount, type AppState } from '../src/state'
import { assertFits, env, frame, g, NOW, paired, perm, question, recv } from './helpers'
import { render } from '../src/render'

const SLEEP = 10_000
const tick = (s: AppState, now: number) => reduce(s, { type: 'tick', now }).state
const session = (state: 'idle' | 'working' | 'waiting' | 'stopped', ts = NOW) => env('session', { name: 'repo', cwd: '/r', state }, ts)
/** Paired, sleep on, and a turn that started at NOW. */
const working = (): AppState => recv(reduce(paired(), { type: 'config', displaySleepMs: SLEEP }).state, session('working'), NOW)
const dark = (s: AppState) => s.dark

describe('display sleep', () => {
  test('off by default: the display never goes dark on its own', () => {
    const s = recv(paired(), session('working'))
    expect(dark(tick(s, NOW + 3_600_000))).toBe(false)
  })

  test('goes dark once a turn has run for the set time with no gesture, and draws nothing', () => {
    const s = working()
    expect(dark(tick(s, NOW + SLEEP - 1))).toBe(false)
    const off = tick(s, NOW + SLEEP)
    expect(dark(off)).toBe(true)
    expect(frame(off)).toEqual({ header: '', timeline: '' })
    const scene = render(off)
    expect(scene.containers.every(c => c.content === '' && c.box.border === 0)).toBe(true)
    expect(scene.containers.some(c => c.capture)).toBe(true) // gestures still arrive
    assertFits(scene)
  })

  test('a gesture restarts the timer', () => {
    const s = g(working(), 'scroll_up', NOW + SLEEP - 1000).state
    expect(dark(tick(s, NOW + SLEEP))).toBe(false)
    expect(dark(tick(s, NOW + 2 * SLEEP))).toBe(true)
  })

  test('never sleeps while idle, or while a card, question, menu or voice box is up', () => {
    const idle = recv(reduce(paired(), { type: 'config', displaySleepMs: SLEEP }).state, session('idle'))
    expect(dark(tick(idle, NOW + 10 * SLEEP))).toBe(false)
    const card = recv(working(), env('permission', perm()))
    expect(dark(tick(card, NOW + 10 * SLEEP))).toBe(false)
    const menu = g(working(), 'tap', NOW).state
    expect(dark(tick(menu, NOW + 10 * SLEEP))).toBe(false)
  })

  test('wakes for a reply, the turn ending, a card or a question, and stays on afterwards', () => {
    const off = tick(working(), NOW + SLEEP)
    const later = NOW + SLEEP + 5_000
    for (const e of [
      env('reply', { text: 'Done.' }, later),
      session('idle', later),
      session('stopped', later),
      env('permission', perm(), later),
      env('question', question(), later),
    ]) {
      const woke = recv(off, e, later)
      expect(dark(woke)).toBe(false)
    }
    // After the turn ends it stays up, however long.
    const done = recv(off, session('idle', later), later)
    expect(dark(tick(done, later + 100 * SLEEP))).toBe(false)
  })

  test('working events and history replays do not wake it', () => {
    const off = tick(working(), NOW + SLEEP)
    const later = NOW + SLEEP + 5_000
    expect(dark(recv(off, env('event', { type: 'tool_start', tool: 'Bash', summary: 'ls' }, later), later))).toBe(true)
    expect(dark(recv(off, env('reply', { text: 'old' }, NOW - 3_600_000), later))).toBe(true)
  })

  test('a new turn after waking starts the timer again', () => {
    const later = NOW + SLEEP + 5_000
    const awake = recv(tick(working(), NOW + SLEEP), session('idle', later), later)
    const again = recv(awake, session('working', later + 1_000), later + 1_000)
    expect(dark(tick(again, later + 1_000 + SLEEP - 1))).toBe(false)
    expect(dark(tick(again, later + 1_000 + SLEEP))).toBe(true)
  })

  test('a gesture on a dark display only wakes it', () => {
    const off = tick(working(), NOW + SLEEP)
    const r = g(off, 'tap', NOW + SLEEP + 1)
    expect([r.state.dark, r.state.screen, r.effects]).toEqual([false, 'timeline', []])
  })

  test('Display off in the menu turns it off by hand, even with sleep off', () => {
    let s = recv(paired(), session('idle'))
    for (const x of ['tap', 'scroll_down', 'scroll_down'] as const) s = g(s, x, NOW).state
    const off = g(s, 'tap', NOW).state
    expect([off.dark, off.screen]).toEqual([true, 'timeline'])
    expect(dark(g(off, 'scroll_down', NOW + 1).state)).toBe(false)
  })

  test('turning sleep off wakes a dark display', () => {
    const off = tick(working(), NOW + SLEEP)
    expect(dark(reduce(off, { type: 'config', displaySleepMs: 0 }).state)).toBe(false)
  })
})

describe('voice review scrolling', () => {
  const LONG = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ') + ' and finally the end.'
  const review = (text: string): AppState => ({ ...paired(), screen: 'voice', voice: { phase: 'review', attempt: 1, text } })

  test('swipes scroll the spoken prompt, not the timeline, within bounds', () => {
    const s = review(LONG)
    const total = voiceLineCount(LONG)
    expect(total).toBeGreaterThan(VOICE_REVIEW_LINES)
    const down = g(s, 'scroll_down').state
    expect(down.voice.scroll).toBe(3)
    expect(down.screen).toBe('voice')
    let end = s
    for (let i = 0; i < 20; i++) end = g(end, 'scroll_down').state
    expect(end.voice.scroll).toBe(total - VOICE_REVIEW_LINES)
    expect(frame(end).overlay!.content).toContain('the end.')
    expect(g(s, 'scroll_up').state.voice.scroll).toBe(0)
  })

  test('the box says which lines are showing, and fits', () => {
    const s = g(review(LONG), 'scroll_down').state
    const first = frame(s).overlay!.content.split('\n')[0]!
    expect(first).toMatch(/^Send to Claude\? +▲▼ 4-8 of \d+$/)
    expect(frame(s).header).toContain('↑↓ read')
    assertFits(render(s))
  })

  test('a short prompt shows whole, with no scroll marks', () => {
    const s = review('Run the tests.')
    expect(frame(s).overlay!.content).toBe('Send to Claude?\nRun the tests.')
    expect(g(s, 'scroll_down').state.voice.scroll ?? 0).toBe(0)
  })

  test('maps saved before voice scrolling get it; deliberate choices are kept', () => {
    const old = { ...DEFAULT_GESTURES, voice: { ...DEFAULT_GESTURES.voice, scroll_up: 'none', scroll_down: 'none' } }
    expect(parseGestureMap(JSON.stringify(old)).voice).toEqual(DEFAULT_GESTURES.voice)
    const custom = { ...DEFAULT_GESTURES, voice: { ...DEFAULT_GESTURES.voice, scroll_up: 'voice.cancel', scroll_down: 'none' } }
    expect(parseGestureMap(JSON.stringify(custom)).voice.scroll_up).toBe('voice.cancel')
  })
})
