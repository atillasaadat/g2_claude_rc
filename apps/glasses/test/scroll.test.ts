// Timeline scrolling: live shows the newest lines; history goes to the glasses
// as a chunk they scroll through themselves.
import { describe, expect, test } from 'bun:test'
import { buildTimeline } from '../src/timeline'
import { TIMELINE_LINES } from '../src/layout'
import { CHUNK_CHARS, reduce, view, type AppState } from '../src/state'
import { env, frame, g, gs, NOW, paired, perm, recv, withLines } from './helpers'

const lines = (s: AppState) => buildTimeline(view(s).entries).lines
const shown = (s: AppState) => frame(s).timeline.split('\n')

describe('scrolling the timeline', () => {
  test('live shows exactly the newest lines, so every swipe reaches the app', () => {
    const s = withLines(paired(), 30)
    expect(shown(s)).toEqual(lines(s).slice(-TIMELINE_LINES))
    expect(view(s).chunk).toBeUndefined()
  })

  test('a swipe up loads a chunk from 3 lines up to the newest, for the glasses to scroll', () => {
    const live = withLines(paired(), 30)
    const s = gs(live, 'scroll_up')
    const all = lines(s)
    const top = all.length - TIMELINE_LINES - 3
    expect(shown(s)).toEqual(all.slice(top))
    expect(shown(s).length).toBe(TIMELINE_LINES + 3)
    expect(frame(s).header.endsWith('▼ newer')).toBe(true)
  })

  test('a swipe up at the top of a chunk loads the lines above it', () => {
    const s = gs(withLines(paired(), 30), 'scroll_up', 'scroll_up')
    const all = lines(s)
    expect(shown(s)[0]).toBe(all[all.length - TIMELINE_LINES - 6])
  })

  test('a swipe down at the bottom of a chunk continues one line on, then back to live', () => {
    let s = gs(withLines(paired(), 30), 'scroll_up', 'scroll_up', 'scroll_up', 'scroll_up')
    const all = lines(s)
    const end = all.indexOf(shown(s).at(-1)!)
    // The chunk ends before the newest line only if it was cut to fit; here it reaches it.
    expect(end).toBe(all.length - 1)
    s = gs(s, 'scroll_down')
    expect(view(s).fromBottom).toBe(0)
    expect(shown(s)).toEqual(all.slice(-TIMELINE_LINES))
  })

  test('a long history is cut into chunks that fit one upgrade', () => {
    let s = withLines(paired(), 200)
    for (let i = 0; i < 40; i++) s = gs(s, 'scroll_up')
    const text = frame(s).timeline
    expect(text.length).toBeLessThanOrEqual(CHUNK_CHARS)
    const all = lines(s)
    const first = all.indexOf(shown(s)[0]!)
    const last = all.indexOf(shown(s).at(-1)!)
    expect(last).toBeLessThan(all.length - 1)
    // At its end, the next chunk starts one line further down than the last screen did.
    s = gs(s, 'scroll_down')
    expect(shown(s)[0]).toBe(all[last - TIMELINE_LINES + 2])
    expect(first).toBeGreaterThanOrEqual(0)
  })

  test('new activity does not redraw a chunk being read (a redraw would jump it to the top)', () => {
    const s = gs(withLines(paired(), 30), 'scroll_up')
    const later = recv(s, env('event', { type: 'notify', summary: 'something new' }))
    expect(frame(later).timeline).toBe(frame(s).timeline)
    expect(view(gs(later, 'double_tap')).chunk).toBeUndefined()
    expect(shown(gs(later, 'double_tap')).at(-1)).toBe('! something new')
  })

  test('under an overlay the timeline fits again, so swipes move the card', () => {
    const s = recv(gs(withLines(paired(), 30), 'scroll_up'), env('permission', perm()))
    expect(s.screen).toBe('card')
    expect(shown(s).length).toBeLessThanOrEqual(TIMELINE_LINES)
  })

  test('a new turn from the timeline goes back to live', () => {
    const s = gs(withLines(paired(), 30), 'scroll_up')
    const next = recv(s, env('event', { type: 'prompt', summary: 'next task' }))
    expect(view(next).chunk).toBeUndefined()
    expect(view(next).fromBottom).toBe(0)
  })

  test('a reply taller than the view lands on its first line, with the rest in the chunk', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Reply line ${i + 1}`).join('\n')
    const s = recv(withLines(paired(), 5), env('reply', { text }))
    expect(shown(s)[0]).toBe('Reply line 1')
    expect(shown(s).at(-1)).toBe('Reply line 20')
  })

  test('the next long reply also lands on its first line, though the last one left the view in a chunk', () => {
    const long = (n: number) => Array.from({ length: 20 }, (_, i) => `Reply ${n} line ${i + 1}`).join('\n')
    let s = recv(withLines(paired(), 5), env('reply', { text: long(1) }))
    expect(view(s).fromBottom).toBeGreaterThan(0)
    // A prompt typed in the terminal (or spoken while the voice box was still up).
    s = recv({ ...s, screen: 'voice' }, env('event', { type: 'prompt', summary: 'next' }))
    s = recv({ ...s, screen: 'timeline' }, env('reply', { text: long(2) }))
    expect(shown(s)[0]).toBe('Reply 2 line 1')
  })

  test('a reply does not move a view the user scrolled during the turn', () => {
    let s = recv(withLines(paired(), 30), env('event', { type: 'prompt', summary: 'go' }))
    s = gs(s, 'scroll_up')
    const before = shown(s)
    s = recv(s, env('reply', { text: Array.from({ length: 20 }, (_, i) => `R ${i}`).join('\n') }))
    expect(shown(s)).toEqual(before)
    // The next prompt ends the reading: its reply lands again.
    s = recv(s, env('event', { type: 'prompt', summary: 'again' }))
    s = recv(s, env('reply', { text: Array.from({ length: 20 }, (_, i) => `Q ${i}`).join('\n') }))
    expect(shown(s)[0]).toBe('Q 0')
  })

  test('swiping up at the very top does nothing', () => {
    let s = gs(withLines(paired(), 12), 'scroll_up', 'scroll_up', 'scroll_up')
    const top = frame(s).timeline
    s = g(s, 'scroll_up').state
    expect(frame(s).timeline).toBe(top)
    expect(reduce(s, { type: 'tick', now: NOW + 1 }).state.views).toBe(s.views)
  })
})
