import { describe, expect, test } from 'bun:test'
import { getTextWidth } from '@evenrealities/pretext'
import { makeEnvelope, type AnyEnvelope, type Body, type Kind } from '@g2cc/protocol'
import { DEFAULT_GESTURES, type Gesture } from '../src/gestures'
import { BODY_LINES, INNER_WIDTH } from '../src/layout'
import { render } from '../src/render'
import { CARD_GUARD_MS, initialState, reduce, type AppState } from '../src/state'
import { matchOption } from '../src/voice'

const NOW = 1_800_000_000_000
const LATER = NOW + CARD_GUARD_MS + 1
const env = <K extends Kind>(kind: K, body: Body<K>, ts = NOW): AnyEnvelope => ({ ...makeEnvelope(kind, body), ts }) as AnyEnvelope
const recv = (s: AppState, e: AnyEnvelope, now = NOW) => reduce(s, { type: 'envelope', env: e, now }).state
const g = (s: AppState, gesture: Gesture, now = LATER) => reduce(s, { type: 'gesture', gesture, map: DEFAULT_GESTURES, now })
const q = (question_id = 'q00000001', options = ['main', 'dev', 'release']): Body<'question'> => ({ question_id, question: 'Which branch should I deploy?', options })
const perm: Body<'permission'> = { request_id: 'abcde', tool_name: 'Bash', description: 'd', input_preview: '{}' }
const paired = (): AppState =>
  recv({ ...initialState(), paired: true, voiceAvailable: true }, env('session', { name: 'repo', cwd: '/x', state: 'idle' }))

describe('questions: state', () => {
  test('a fresh question opens with the first option highlighted', () => {
    const s = recv(paired(), env('question', q()))
    expect(s.screen).toBe('question')
    expect(s.questionIndex).toBe(0)
  })

  test('stale questions from history and duplicates are ignored', () => {
    expect(recv(paired(), env('question', q(), NOW - 10 * 60_000)).questions).toEqual([])
    const s = recv(recv(paired(), env('question', q())), env('question', q(), NOW + 5))
    expect(s.questions).toHaveLength(1)
  })

  test('scroll moves within the options, tap answers', () => {
    let s = recv(paired(), env('question', q()))
    s = g(g(g(s, 'scroll_down').state, 'scroll_down').state, 'scroll_down').state
    expect(s.questionIndex).toBe(2)
    s = g(s, 'scroll_up').state
    const r = g(s, 'tap')
    expect(r.effects).toEqual([{ type: 'send', kind: 'answer', body: { question_id: 'q00000001', choice: 'dev' } }])
    expect(r.state.questions).toEqual([])
    expect(r.state.screen).toBe('feed')
  })

  test('the input guard applies', () => {
    const s = recv(paired(), env('question', q()))
    expect(g(s, 'tap', NOW + 100).effects).toEqual([])
  })

  test('a permission card outranks a question, which comes back afterwards', () => {
    let s = recv(paired(), env('question', q()))
    s = recv(s, env('permission', perm))
    expect(s.screen).toBe('card')
    s = g(s, 'tap').state // deny
    expect(s.screen).toBe('question')
  })

  test('a question arriving during a permission card waits its turn', () => {
    let s = recv(paired(), env('permission', perm))
    s = recv(s, env('question', q()))
    expect(s.screen).toBe('card')
    s = recv(s, env('permission_resolved', { request_id: 'abcde' }))
    expect(s.screen).toBe('question')
  })

  test('double tap leaves it pending; the menu offers Review question', () => {
    let s = g(recv(paired(), env('question', q())), 'double_tap').state
    expect(s.screen).toBe('feed')
    s = g(s, 'tap').state
    expect(render(s).body.split('\n')[0]).toBe('▶ Review question')
    s = g(s, 'tap').state
    expect(s.screen).toBe('question')
  })

  test('speaking an option after Talk selects it on the question card', () => {
    let s = g(recv(paired(), env('question', q())), 'double_tap').state
    s = g(g(s, 'tap').state, 'scroll_down').state // menu, highlight Talk
    s = g(s, 'tap').state // Talk
    expect(s.screen).toBe('voice')
    s = g(s, 'tap').state // done
    s = reduce(s, { type: 'transcript', attempt: s.voice.attempt, text: 'The second one.', now: LATER }).state
    expect(s.screen).toBe('question')
    expect(s.questionIndex).toBe(1)
  })

  test('speech that matches no option stays a prompt to review', () => {
    let s = g(recv(paired(), env('question', q())), 'double_tap').state
    s = g(g(g(s, 'tap').state, 'scroll_down').state, 'tap').state
    s = g(s, 'tap').state
    s = reduce(s, { type: 'transcript', attempt: s.voice.attempt, text: 'actually run the tests first', now: LATER }).state
    expect(s.screen).toBe('voice')
    expect(s.voice.phase).toBe('review')
  })
})

describe('matchOption', () => {
  const opts = ['main', 'dev', 'release candidate']
  test.each([
    ['first', 0],
    ['The first one.', 0],
    ['option two', 1],
    ['number 3', 2],
    ['third', 2],
    ['dev', 1],
    ['Dev.', 1],
    ['release', 2],
    ['the release candidate please', 2],
  ])('%p -> %p', (t, i) => {
    expect(matchOption(t, opts)).toBe(i)
  })

  test.each(['fourth', 'something else', '', 'de', 'actually run the tests first'])('%p -> null', t => {
    expect(matchOption(t, opts)).toBeNull()
  })

  test('ambiguous text matches nothing', () => {
    expect(matchOption('test', ['unit test', 'e2e test'])).toBeNull()
  })
})

describe('questions: render', () => {
  test('question, options with highlight, and fits', () => {
    const out = render(recv(paired(), env('question', q())))
    expect(out.header).toBe('Question')
    const lines = out.body.split('\n')
    expect(lines[0]).toBe('Which branch should I deploy?')
    expect(lines).toContain('▶ main')
    expect(lines).toContain('   dev')
    expect(lines.length).toBeLessThanOrEqual(BODY_LINES)
    for (const l of lines) expect(getTextWidth(l)).toBeLessThanOrEqual(INNER_WIDTH)
  })

  test('long questions are cut, and the header counts the queue', () => {
    let s = recv(paired(), env('question', { ...q(), question: 'word '.repeat(200) }))
    s = recv(s, env('question', q('q00000002')))
    const out = render(s)
    expect(out.header).toBe('Question · 1/2')
    expect(out.body.split('\n').length).toBeLessThanOrEqual(BODY_LINES)
  })
})
