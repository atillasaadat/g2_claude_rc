import { describe, expect, test } from 'bun:test'
import { getTextWidth } from '@evenrealities/pretext'
import { makeEnvelope, type AnyEnvelope, type Body, type Kind } from '@g2cc/protocol'
import { BODY_LINES, INNER_WIDTH } from '../src/layout'
import { render } from '../src/render'
import { initialState, reduce, type AppState } from '../src/state'

const NOW = 1_800_000_000_000
const env = <K extends Kind>(kind: K, body: Body<K>): AnyEnvelope => ({ ...makeEnvelope(kind, body), ts: NOW }) as AnyEnvelope
const feed = (...envs: AnyEnvelope[]): AppState =>
  envs.reduce<AppState>((s, e) => reduce(s, { type: 'envelope', env: e, now: NOW }).state, { ...initialState(), paired: true })

function assertFits(text: string, maxLines: number) {
  const lines = text.split('\n')
  expect(lines.length).toBeLessThanOrEqual(maxLines)
  for (const l of lines) expect(getTextWidth(l)).toBeLessThanOrEqual(INNER_WIDTH)
}

describe('render', () => {
  test('unpaired shows instructions', () => {
    const out = render(initialState())
    expect(out.body).toContain('Not paired')
    assertFits(out.header, 1)
    assertFits(out.body, BODY_LINES)
  })

  test('header shows connection, session, state, and mode', () => {
    let s = feed(env('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'working', mode: 'auto' }))
    s = reduce(s, { type: 'relay', status: 'open' }).state
    s = reduce(s, { type: 'presence', computers: 1 }).state
    expect(render(s).header).toBe('● g2cc-sandbox · working · auto')
    s = reduce(s, { type: 'presence', computers: 0 }).state
    expect(render(s).header.startsWith('○ ')).toBe(true)
    s = reduce(s, { type: 'relay', status: 'closed' }).state
    expect(render(s).header.startsWith('× ')).toBe(true)
  })

  test('feed lists the last four events, glance, and a reply hint', () => {
    const s = feed(
      env('event', { type: 'prompt', summary: 'old prompt', origin: 'local' }),
      env('event', { type: 'prompt', summary: 'run the tests', origin: 'glasses' }),
      env('event', { type: 'tool_start', tool: 'Bash', summary: 'bun test' }),
      env('event', { type: 'tool_end', tool: 'Bash', summary: 'ok' }),
      env('event', { type: 'tool_start', tool: 'Edit', summary: 'src/a.ts' }),
      env('event', { type: 'notify', summary: 'Claude needs your permission' }),
      env('glance', { text: 'Tests pass' }),
      { ...env('reply', { text: 'All 12 tests pass.' }), ts: NOW - 10 * 60_000 } as AnyEnvelope,
    )
    const body = render(s).body
    expect(body).not.toContain('old prompt')
    expect(body).toContain('> run the tests')
    expect(body).toContain('• Bash: bun test → ok')
    expect(body).toContain('▶ Edit: src/a.ts')
    expect(body).toContain('! Claude needs your permission')
    expect(body).toContain('Tests pass')
    expect(body).toContain('↓ reply')
    assertFits(body, BODY_LINES)
  })

  test('long event lines are truncated to one line', () => {
    const s = feed(env('event', { type: 'tool_start', tool: 'Bash', summary: 'x '.repeat(200) }))
    assertFits(render(s).body, BODY_LINES)
  })

  test('scrolled feed shows an older-events marker', () => {
    let s = feed(...Array.from({ length: 8 }, (_, i) => env('event', { type: 'notify', summary: `n${i}` })))
    s = { ...s, feedOffset: 2 }
    const body = render(s).body
    expect(body).toContain('n2')
    expect(body).not.toContain('n7')
    expect(body).toContain('↑↓ 2 newer')
  })

  test('reply view paginates and labels pages', () => {
    const long = Array.from({ length: 20 }, (_, i) => `paragraph ${i} `.repeat(6)).join('\n')
    const s = feed(env('reply', { text: long }))
    const out = render(s)
    expect(out.header).toMatch(/^Reply 1\/\d+/)
    assertFits(out.header, 1)
    assertFits(out.body, BODY_LINES)
  })

  test('empty feed says so', () => {
    expect(render(feed()).body).toContain('No activity yet')
  })
})
