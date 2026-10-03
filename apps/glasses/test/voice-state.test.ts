import { describe, expect, test } from 'bun:test'
import { makeEnvelope, type AnyEnvelope, type Body, type Kind } from '@g2cc/protocol'
import { DEFAULT_GESTURES, type Gesture } from '../src/gestures'
import { render } from '../src/render'
import { CARD_GUARD_MS, initialState, micWanted, reduce, type AppState } from '../src/state'

const NOW = 1_800_000_000_000
const env = <K extends Kind>(kind: K, body: Body<K>): AnyEnvelope => ({ ...makeEnvelope(kind, body), ts: NOW }) as AnyEnvelope
const g = (s: AppState, gesture: Gesture) => reduce(s, { type: 'gesture', gesture, map: DEFAULT_GESTURES, now: NOW + CARD_GUARD_MS + 1 })
const base = (): AppState =>
  reduce(
    { ...initialState(), paired: true, voiceAvailable: true },
    { type: 'envelope', env: env('session', { name: 'repo', cwd: '/r', state: 'idle' }), now: NOW },
  ).state
const listening = () => g(g(base(), 'tap').state, 'tap').state // menu, Talk
const heard = (s: AppState, text: string) => reduce(s, { type: 'transcript', attempt: s.voice.attempt, text, now: NOW })

describe('voice capture', () => {
  test('menu Talk starts listening and turns the mic on', () => {
    const s = listening()
    expect(s.screen).toBe('voice')
    expect(s.voice.phase).toBe('listening')
    expect(micWanted(s)).toBe(true)
  })

  test('Talk is unavailable without a Groq key', () => {
    let s = g({ ...base(), voiceAvailable: false }, 'tap').state
    expect(render(s).body).toContain('Talk (no Groq key)')
    s = g(s, 'tap').state
    expect(s.screen).toBe('menu')
  })

  test('tap stops recording and transcribes; the mic goes off', () => {
    const s = g(listening(), 'tap').state
    expect(s.voice.phase).toBe('transcribing')
    expect(micWanted(s)).toBe(false)
  })

  test('a transcript is shown for review; tap sends it as a prompt', () => {
    let s = g(listening(), 'tap').state
    s = heard(s, 'Run the unit tests.').state
    expect(s.voice).toMatchObject({ phase: 'review', text: 'Run the unit tests.' })
    const r = g(s, 'tap')
    expect(r.effects).toEqual([{ type: 'send', kind: 'prompt', body: { text: 'Run the unit tests.' } }])
    expect(r.state.screen).toBe('feed')
  })

  test('double tap cancels at any phase, and nothing is sent', () => {
    for (const s0 of [listening(), g(listening(), 'tap').state, heard(g(listening(), 'tap').state, 'hello').state]) {
      const r = g(s0, 'double_tap')
      expect(r.state.screen).toBe('feed')
      expect(r.effects).toEqual([])
      expect(micWanted(r.state)).toBe(false)
    }
  })

  test('saying "stop" stops Claude immediately, without review', () => {
    const r = heard(g(listening(), 'tap').state, 'Stop.')
    expect(r.effects).toEqual([{ type: 'send', kind: 'stop', body: {} }])
    expect(r.state.screen).toBe('feed')
    expect(r.state.stopPending).toBe(true)
  })

  test('saying "cancel" discards', () => {
    const r = heard(g(listening(), 'tap').state, 'cancel')
    expect(r.effects).toEqual([])
    expect(r.state.screen).toBe('feed')
  })

  test('"approve" with no card showing is not sent anywhere', () => {
    const r = heard(g(listening(), 'tap').state, 'approve')
    expect(r.effects).toEqual([])
    expect(r.state.voice).toMatchObject({ phase: 'error', error: 'No approval is waiting' })
  })

  test('silence asks to try again; tap retries', () => {
    let s = heard(g(listening(), 'tap').state, 'Thank you.').state
    expect(s.voice).toMatchObject({ phase: 'error', error: "Didn't catch that" })
    s = g(s, 'tap').state
    expect(s.voice.phase).toBe('listening')
    expect(micWanted(s)).toBe(true)
  })

  test('a transcription error is shown', () => {
    const s = reduce(g(listening(), 'tap').state, { type: 'transcript_error', attempt: 1, message: 'Groq rejected the API key' }).state
    expect(s.voice).toMatchObject({ phase: 'error', error: 'Groq rejected the API key' })
  })

  test('a late transcript from a cancelled attempt is ignored', () => {
    const transcribing = g(listening(), 'tap').state
    const cancelled = g(transcribing, 'double_tap').state
    const r = reduce(cancelled, { type: 'transcript', attempt: transcribing.voice.attempt, text: 'stop', now: NOW })
    expect(r.effects).toEqual([])
    expect(r.state.screen).toBe('feed')
  })

  test('the recording limit ends listening and transcribes', () => {
    const s = reduce(listening(), { type: 'voice_limit' }).state
    expect(s.voice.phase).toBe('transcribing')
  })

  test('a permission card preempts voice capture and turns the mic off', () => {
    const s = reduce(listening(), {
      type: 'envelope',
      env: env('permission', { request_id: 'abcde', tool_name: 'Bash', description: 'd', input_preview: '{}' }),
      now: NOW,
    }).state
    expect(s.screen).toBe('card')
    expect(micWanted(s)).toBe(false)
  })

  test('voice keywords answer a showing card', () => {
    let s = reduce(base(), {
      type: 'envelope',
      env: env('permission', { request_id: 'abcde', tool_name: 'Bash', description: 'd', input_preview: '{}' }),
      now: NOW,
    }).state
    // A transcript that arrives while the card shows (recording started before it).
    s = { ...s, voice: { ...s.voice, attempt: 7, phase: 'transcribing' } }
    const r = reduce(s, { type: 'transcript', attempt: 7, text: 'Approve.', now: NOW })
    expect(r.effects).toEqual([{ type: 'send', kind: 'verdict', body: { request_id: 'abcde', behavior: 'allow' } }])
  })
})

describe('voice render', () => {
  test('listening, transcribing, review, and error screens', () => {
    let s = listening()
    expect(render(s).header).toBe('Listening…')
    s = g(s, 'tap').state
    expect(render(s).header).toBe('Transcribing…')
    s = heard(s, 'Run the unit tests.').state
    expect(render(s).header).toBe('Send to Claude?')
    expect(render(s).body.split('\n')[0]).toBe('Run the unit tests.')
    expect(render(s).body).toContain('tap: send · double tap: cancel')
    s = reduce(s, { type: 'transcript_error', attempt: s.voice.attempt, message: 'x' }).state
  })
})
