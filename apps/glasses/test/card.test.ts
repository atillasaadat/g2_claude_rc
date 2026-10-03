import { describe, expect, test } from 'bun:test'
import { getTextWidth } from '@evenrealities/pretext'
import { makeEnvelope, type AnyEnvelope, type Body, type Kind } from '@g2cc/protocol'
import { DEFAULT_GESTURES, type Gesture } from '../src/gestures'
import { BODY_LINES, INNER_WIDTH } from '../src/layout'
import { render } from '../src/render'
import { CARD_GUARD_MS, initialState, reduce, type AppState } from '../src/state'

const NOW = 1_800_000_000_000
const env = <K extends Kind>(kind: K, body: Body<K>, ts = NOW): AnyEnvelope => ({ ...makeEnvelope(kind, body), ts }) as AnyEnvelope
const recv = (s: AppState, e: AnyEnvelope, now = NOW) => reduce(s, { type: 'envelope', env: e, now }).state
const tap = (s: AppState, gesture: Gesture, now = NOW + CARD_GUARD_MS + 1) => reduce(s, { type: 'gesture', gesture, map: DEFAULT_GESTURES, now })
const perm = (request_id = 'abcde', tool_name = 'Bash'): Body<'permission'> => ({
  request_id,
  tool_name,
  description: 'Create empty test file',
  input_preview: '{ "command": "touch perm-test-3.txt", "description": "Create empty test file" }',
})
const paired = (): AppState =>
  recv({ ...initialState(), paired: true }, env('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'working' }))

describe('permission cards: state', () => {
  test('a fresh request preempts the screen with Deny highlighted', () => {
    const s = recv({ ...paired(), screen: 'reply' }, env('permission', perm()))
    expect(s.screen).toBe('card')
    expect(s.cards.map(c => c.request_id)).toEqual(['abcde'])
    expect(s.cardChoice).toBe('deny')
  })

  test('a stale request from history replay is ignored', () => {
    const s = recv(paired(), env('permission', perm(), NOW - 5 * 60_000))
    expect(s.cards).toEqual([])
    expect(s.screen).toBe('feed')
  })

  test('the same request twice (resync) does not duplicate', () => {
    let s = recv(paired(), env('permission', perm()))
    s = recv(s, env('permission', perm(), NOW + 10))
    expect(s.cards).toHaveLength(1)
  })

  test('scroll up selects Allow, tap sends allow and closes the card', () => {
    let s = recv(paired(), env('permission', perm()))
    s = tap(s, 'scroll_up').state
    expect(s.cardChoice).toBe('allow')
    const r = tap(s, 'tap')
    expect(r.effects).toEqual([{ type: 'send', kind: 'verdict', body: { request_id: 'abcde', behavior: 'allow' } }])
    expect(r.state.cards).toEqual([])
    expect(r.state.screen).toBe('feed')
  })

  test('tap with the default highlight denies', () => {
    const r = tap(recv(paired(), env('permission', perm())), 'tap')
    expect(r.effects).toEqual([{ type: 'send', kind: 'verdict', body: { request_id: 'abcde', behavior: 'deny' } }])
  })

  test('taps right after a card appears are ignored', () => {
    const s = recv(paired(), env('permission', perm()))
    const r = tap(s, 'tap', NOW + CARD_GUARD_MS - 1)
    expect(r.effects).toEqual([])
    expect(r.state.screen).toBe('card')
  })

  test('queued cards are shown one after another', () => {
    let s = recv(paired(), env('permission', perm('abcde')))
    s = recv(s, env('permission', perm('fghij', 'Write')))
    const r = tap(s, 'tap')
    expect(r.state.screen).toBe('card')
    expect(r.state.cards.map(c => c.request_id)).toEqual(['fghij'])
    expect(r.state.cardChoice).toBe('deny')
  })

  test('permission_resolved closes the card (answered in the terminal or on the phone)', () => {
    let s = recv(paired(), env('permission', perm()))
    s = recv(s, env('permission_resolved', { request_id: 'abcde' }))
    expect(s.cards).toEqual([])
    expect(s.screen).toBe('feed')
  })

  test('double tap leaves the card pending; the menu offers to review it', () => {
    let s = recv(paired(), env('permission', perm()))
    s = tap(s, 'double_tap').state
    expect(s.screen).toBe('feed')
    expect(s.cards).toHaveLength(1)
    s = tap(s, 'tap').state // open menu
    expect(render(s).body.split('\n')[0]).toBe('▶ Review: Bash')
    s = tap(s, 'tap').state // choose Review
    expect(s.screen).toBe('card')
    expect(s.cardChoice).toBe('deny')
  })

  test('menu Stop still works with a card pending', () => {
    let s = recv(paired(), env('permission', perm()))
    s = tap(s, 'double_tap').state
    s = tap(s, 'tap').state
    s = tap(s, 'scroll_down').state
    s = tap(s, 'scroll_down').state
    const r = tap(s, 'tap')
    expect(r.effects).toEqual([{ type: 'send', kind: 'stop', body: {} }])
  })
})

describe('permission cards: render', () => {
  function assertFits(text: string, maxLines: number) {
    const lines = text.split('\n')
    expect(lines.length).toBeLessThanOrEqual(maxLines)
    for (const l of lines) expect(getTextWidth(l)).toBeLessThanOrEqual(INNER_WIDTH)
  }

  test('shows tool, description, preview, and the two choices', () => {
    const out = render(recv(paired(), env('permission', perm())))
    expect(out.header).toBe('Allow Bash?')
    const lines = out.body.split('\n')
    expect(lines[0]).toBe('Create empty test file')
    expect(out.body).toContain('touch perm-test-3.txt')
    expect(lines.at(-2)).toBe('   Allow')
    expect(lines.at(-1)).toBe('▶ Deny')
    assertFits(out.header, 1)
    assertFits(out.body, BODY_LINES)
  })

  test('the preview shows the command, not a repeat of the description', () => {
    const out = render(recv(paired(), env('permission', perm())))
    expect(out.body.split('\n').filter(l => l.includes('Create empty test file'))).toHaveLength(1)
  })

  test('long previews are cut to fit, and the header counts the queue', () => {
    let s = recv(paired(), env('permission', { ...perm(), input_preview: JSON.stringify({ command: 'echo ' + 'word '.repeat(300) }) }))
    s = recv(s, env('permission', perm('fghij')))
    const out = render(s)
    expect(out.header).toBe('Allow Bash? · 1/2')
    assertFits(out.body, BODY_LINES)
  })

  test('non-JSON previews are shown as text', () => {
    const out = render(recv(paired(), env('permission', { ...perm(), input_preview: 'plain preview text' })))
    expect(out.body).toContain('plain preview text')
  })
})
