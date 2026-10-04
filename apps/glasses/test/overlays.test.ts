import { describe, expect, test } from 'bun:test'
import { CARD_GUARD_MS, micWanted, reduce, type AppState } from '../src/state'
import { matchOption } from '../src/voice'
import { env, frame, g, gs, LATER, NOW, paired, perm, question, recv } from './helpers'

const card = (s = paired()) => recv(s, env('permission', perm()))

describe('permission cards', () => {
  test('a fresh request opens over the timeline with Deny highlighted', () => {
    const s = card()
    expect(s.screen).toBe('card')
    expect(s.cardChoice).toBe('deny')
  })

  test('stale requests from history and duplicates are ignored', () => {
    expect(recv(paired(), env('permission', perm(), NOW - 5 * 60_000)).cards).toEqual([])
    expect(recv(card(), env('permission', perm(), NOW + 5)).cards).toHaveLength(1)
  })

  test('swipe up selects Allow, tap sends it and closes the card', () => {
    const r = g(gs(card(), 'scroll_up'), 'tap')
    expect(r.effects).toEqual([{ type: 'send', kind: 'verdict', body: { request_id: 'abcde', behavior: 'allow' }, sid: '' }])
    expect(r.state.screen).toBe('timeline')
  })

  test('the default tap denies; taps inside the guard do nothing', () => {
    expect(g(card(), 'tap').effects).toEqual([{ type: 'send', kind: 'verdict', body: { request_id: 'abcde', behavior: 'deny' }, sid: '' }])
    expect(g(card(), 'tap', NOW + CARD_GUARD_MS - 1).effects).toEqual([])
  })

  test('queued cards show one after another; permission_resolved closes', () => {
    let s = recv(card(), env('permission', perm('fghij', 'Write')))
    s = g(s, 'tap').state
    expect(s.cards.map(c => c.request_id)).toEqual(['fghij'])
    expect(recv(s, env('permission_resolved', { request_id: 'fghij' })).screen).toBe('timeline')
  })

  test('double tap leaves it pending; the menu offers Review', () => {
    let s = gs(card(), 'double_tap', 'tap')
    expect(frame(s).overlay!.content.split('\n')[0]).toBe('▶ Review: Bash')
    s = gs(s, 'tap')
    expect(s.screen).toBe('card')
  })
})

describe('questions', () => {
  const asked = (s = paired()) => recv(s, env('question', question()))

  test('a fresh question opens with the first option highlighted; tap answers', () => {
    const s = gs(asked(), 'scroll_down')
    expect(s.questionIndex).toBe(1)
    const r = g(s, 'tap')
    expect(r.effects).toEqual([{ type: 'send', kind: 'answer', body: { question_id: 'q00000001', choice: 'dev' }, sid: '' }])
    expect(r.state.screen).toBe('timeline')
  })

  test('a permission card outranks a question, which returns afterwards', () => {
    let s = card(asked())
    expect(s.screen).toBe('card')
    s = g(s, 'tap').state
    expect(s.screen).toBe('question')
    const q2 = recv(card(), env('question', question()))
    expect(q2.screen).toBe('card')
    expect(recv(q2, env('permission_resolved', { request_id: 'abcde' })).screen).toBe('question')
  })

  test('live replies and prompts never bury a question, card, menu, or voice', () => {
    const reply = env('reply', { text: 'I sent the question to your glasses.' })
    const prompt = env('event', { type: 'prompt', summary: 'next', origin: 'local' })
    expect(recv(asked(), reply).screen).toBe('question')
    expect(recv(asked(), prompt).screen).toBe('question')
    expect(recv(card(), reply).screen).toBe('card')
    expect(recv(gs(paired(), 'tap'), reply).screen).toBe('menu')
    expect(recv(gs(paired(), 'tap', 'tap'), reply).screen).toBe('voice')
  })

  test('the menu offers Review question', () => {
    expect(frame(gs(asked(), 'double_tap', 'tap')).overlay!.content.split('\n')[0]).toBe('▶ Review question')
  })
})

describe('voice', () => {
  const listening = (s = paired()) => gs(s, 'tap', 'tap')
  const heard = (s: AppState, text: string) => reduce(s, { type: 'transcript', attempt: s.voice.attempt, text, now: LATER })

  test('Talk listens with the mic on; tap transcribes with the mic off', () => {
    const s = listening()
    expect([s.screen, s.voice.phase, micWanted(s)]).toEqual(['voice', 'listening', true])
    const t = gs(s, 'tap')
    expect([t.voice.phase, micWanted(t)]).toEqual(['transcribing', false])
  })

  test('partial transcripts fill in while listening and are ignored otherwise', () => {
    let s = listening()
    s = reduce(s, { type: 'partial', attempt: s.voice.attempt, text: 'run the unit' }).state
    expect(s.voice.partial).toBe('run the unit')
    expect(frame(s).overlay!.content).toContain('run the unit _')
    const stale = reduce(s, { type: 'partial', attempt: s.voice.attempt - 1, text: 'old' }).state
    expect(stale.voice.partial).toBe('run the unit')
    const t = gs(s, 'tap')
    expect(reduce(t, { type: 'partial', attempt: t.voice.attempt, text: 'late' }).state.voice.partial).toBe('run the unit')
  })

  test('review, then tap sends the prompt', () => {
    const s = heard(gs(listening(), 'tap'), 'Run the unit tests.').state
    expect(s.voice).toMatchObject({ phase: 'review', text: 'Run the unit tests.' })
    expect(g(s, 'tap').effects).toEqual([{ type: 'send', kind: 'prompt', body: { text: 'Run the unit tests.' }, sid: '' }])
  })

  test('keywords: stop stops at once, cancel discards, approve with no card is refused', () => {
    const t = gs(listening(), 'tap')
    expect(heard(t, 'Stop.').effects).toEqual([{ type: 'send', kind: 'stop', body: {}, sid: '' }])
    expect(heard(t, 'cancel').state.screen).toBe('timeline')
    expect(heard(t, 'approve').state.voice).toMatchObject({ phase: 'error', error: 'No approval is waiting' })
  })

  test('silence shows an error; tap retries', () => {
    const s = heard(gs(listening(), 'tap'), 'Thank you.').state
    expect(s.voice.error).toBe("Didn't catch that")
    expect(gs(s, 'tap').voice.phase).toBe('listening')
  })

  test('a card preempts listening and turns the mic off; a late transcript can answer it', () => {
    const s = card(listening())
    expect([s.screen, micWanted(s)]).toEqual(['card', false])
    let t = card(gs(listening(), 'tap')) // transcription in flight when the card appears
    const r = heard(t, 'Approve.')
    expect(r.effects).toEqual([{ type: 'send', kind: 'verdict', body: { request_id: 'abcde', behavior: 'allow' }, sid: '' }])
    t = r.state
  })

  test('a spoken option selects it on a waiting question', () => {
    let s = gs(recv(paired(), env('question', question())), 'double_tap', 'tap', 'scroll_down', 'tap', 'tap')
    s = heard(s, 'The second one.').state
    expect([s.screen, s.questionIndex]).toEqual(['question', 1])
  })
})

describe('matchOption', () => {
  const opts = ['main', 'dev', 'release candidate']
  test.each([
    ['first', 0],
    ['The first one.', 0],
    ['option two', 1],
    ['number 3', 2],
    ['Dev.', 1],
    ['the release candidate please', 2],
  ])('%p -> %p', (t, i) => expect(matchOption(t, opts)).toBe(i))
  test.each(['fourth', 'something else', '', 'de', 'actually run the tests first'])('%p -> null', t => expect(matchOption(t, opts)).toBeNull())
  test('ambiguous text matches nothing', () => expect(matchOption('test', ['unit test', 'e2e test'])).toBeNull())
})

describe('questions answered in the terminal', () => {
  test('question_resolved dismisses the card on screen and shows the next one', () => {
    let s = recv(paired(), env('question', question('q00000001')))
    s = recv(s, env('question', question('q00000002', ['yes', 'no'])))
    expect([s.screen, s.questions[0]!.question_id]).toEqual(['question', 'q00000001'])
    s = recv(s, env('question_resolved', { question_id: 'q00000001' }))
    expect([s.screen, s.questions.map(q => q.question_id)]).toEqual(['question', ['q00000002']])
    s = recv(s, env('question_resolved', { question_id: 'q00000002' }))
    expect([s.screen, s.questions]).toEqual(['timeline', []])
    // An unknown or repeated id changes nothing.
    expect(recv(s, env('question_resolved', { question_id: 'q00000009' }))).toBe(s)
  })
})
