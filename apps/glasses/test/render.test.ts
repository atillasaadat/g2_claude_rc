import { describe, expect, test } from 'bun:test'
import { getTextWidth } from '@evenrealities/pretext'
import { HEADER, TIMELINE } from '../src/layout'
import { frameOf, render, HEADER_ID, OVERLAY_ID, TIMELINE_ID } from '../src/render'
import { initialState, reduce, type AppState } from '../src/state'
import { assertFits, env, frame, gs, NOW, paired, perm, question, recv, withLines } from './helpers'

const byId = (s: AppState, id: number) => render(s).containers.find(c => c.id === id)

describe('scene structure', () => {
  test('header and timeline always; the timeline captures input', () => {
    const scene = render(paired())
    expect(scene.containers.map(c => c.name)).toEqual(['header', 'timeline'])
    expect(scene.containers.filter(c => c.capture).map(c => c.id)).toEqual([TIMELINE_ID])
    expect(byId(paired(), HEADER_ID)!.box).toEqual(HEADER)
    expect(byId(paired(), TIMELINE_ID)!.box).toEqual(TIMELINE)
  })

  test('every z index is unique (all-or-nothing rule)', () => {
    const zs = render(recv(paired(), env('permission', perm()))).containers.map(c => c.z)
    expect(new Set(zs).size).toBe(zs.length)
  })

  test('an overlay dims the timeline and fades in', () => {
    const open = gs(paired(), 'tap')
    expect(byId(open, TIMELINE_ID)!.brightness).toBe(1)
    const at = (t: number) => byId(reduce(open, { type: 'tick', now: t }).state, OVERLAY_ID)!.brightness
    const since = open.overlaySince
    expect([at(since), at(since + 200), at(since + 1000)]).toEqual([2, 3, 4])
    expect(byId(paired(), TIMELINE_ID)!.brightness).toBe(4)
  })
})

describe('header', () => {
  test('status with connection dot, and mode on the right', () => {
    let s = reduce(paired(), { type: 'relay', status: 'open' }).state
    s = reduce(s, { type: 'presence', computers: 1 }).state
    const h = frame(s).header
    expect(h.startsWith('● g2cc-sandbox · idle')).toBe(true)
    expect(h.endsWith('auto')).toBe(true)
  })

  test('working dots animate with the clock', () => {
    const w = recv(paired(), env('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'working' }, NOW + 1))
    const at = (t: number) => frame(reduce(w, { type: 'tick', now: t }).state).header
    expect(at(0)).toContain('working ·')
    expect(at(400)).toContain('working ··')
    expect(at(800)).toContain('working ···')
  })

  test('scrolled up shows how many newer lines', () => {
    expect(frame(gs(withLines(paired(), 30), 'scroll_up')).header.endsWith('▼ 3 newer')).toBe(true)
  })

  test('overlays swap the status for their gesture hints', () => {
    expect(frame(gs(paired(), 'tap')).header).toContain('tap: select')
    expect(frame(recv(paired(), env('permission', perm()))).header).toContain('↑ allow')
    expect(frame(gs(paired(), 'tap', 'tap')).header).toBe('tap: done · 2× tap: cancel')
  })

  test('unpaired', () => {
    const f = frame(initialState())
    expect(f.header).toBe('G2 Claude Code · not paired')
    expect(f.timeline).toContain('Not paired')
  })
})

describe('overlays', () => {
  test('menu is a compact box on the right', () => {
    const c = byId(gs(paired(), 'tap'), OVERLAY_ID)!
    expect(c.name).toBe('menu')
    expect(c.box.x).toBeGreaterThan(288)
    expect(c.content.split('\n')).toEqual(['▶ Talk', '   Stop Claude'])
  })

  test('permission card: title, description, preview, and side-by-side choices', () => {
    const lines = frame(recv(paired(), env('permission', perm()))).overlay!.content.split('\n')
    expect(lines[0]).toBe('Allow Bash?')
    expect(lines[1]).toBe('Create empty test file')
    expect(lines).toContain('touch perm-test-3.txt')
    expect(lines.at(-1)).toMatch(/^ {3}Allow +▶ Deny$/)
  })

  test('question card lists options with the highlight', () => {
    const lines = frame(recv(paired(), env('question', question()))).overlay!.content.split('\n')
    expect(lines).toEqual(['Which branch should I deploy?', '', '▶ main', '   dev', '   release'])
  })

  test('voice box pulses while listening and keeps a fixed size as text grows', () => {
    const s = gs(paired(), 'tap', 'tap')
    const at = (t: number, partial?: string) => {
      let x = reduce(s, { type: 'tick', now: t }).state
      if (partial) x = reduce(x, { type: 'partial', attempt: x.voice.attempt, text: partial }).state
      return byId(x, OVERLAY_ID)!
    }
    expect(at(0).content.startsWith('● Listening')).toBe(true)
    expect(at(500).content.startsWith('○ Listening')).toBe(true)
    expect(at(0, 'short').box).toEqual(at(0, 'a much longer partial transcript '.repeat(5)).box)
  })
})

describe('occlusion', () => {
  const tall = withLines(paired(), 20)

  test('a full-width box blanks the timeline rows it covers and leaves the rest', () => {
    const lines = frame(recv(tall, env('permission', perm()))).timeline.split('\n')
    const box = byId(recv(tall, env('permission', perm())), OVERLAY_ID)!.box
    const coveredRows = lines.filter((_, i) => 40 + i * 27 < box.y + box.h).length
    expect(lines.slice(0, coveredRows).every(l => l === '')).toBe(true)
    expect(lines.slice(coveredRows).some(l => l.startsWith('! note'))).toBe(true)
  })

  test('the side menu clips covered rows short of the box', () => {
    const s = gs(tall, 'tap')
    const box = byId(s, OVERLAY_ID)!.box
    const [first] = frame(s).timeline.split('\n')
    expect(getTextWidth(first!)).toBeLessThan(box.x)
  })
})

describe('everything fits', () => {
  test.each([
    ['timeline full of long lines', withLines(recv(paired(), env('reply', { text: 'word '.repeat(400) })), 20)],
    ['menu with review items', gs(recv(recv(paired(), env('permission', perm())), env('question', question())), 'double_tap', 'tap')],
    ['huge permission preview', recv(paired(), env('permission', { ...perm(), input_preview: JSON.stringify({ command: 'echo ' + 'x '.repeat(900) }) }))],
    ['long question with four long options', recv(paired(), env('question', { question_id: 'q1', question: 'why '.repeat(80), options: ['a '.repeat(80), 'b', 'c', 'd'] }))],
    ['voice review of a long transcript', reduce(gs(paired(), 'tap', 'tap', 'tap'), { type: 'transcript', attempt: 1, text: 'please '.repeat(120), now: NOW }).state],
  ])('%s', (_name, s) => {
    assertFits(render(s))
    expect(frameOf(render(s)).timeline.length).toBeLessThanOrEqual(1000)
  })
})
