// Several paired computers: one relay room each, all connected at once.
import { describe, expect, test } from 'bun:test'
import { makeEnvelope, type AnyEnvelope, type Body, type Kind } from '@g2cc/protocol'
import { initialState, reduce, sessionList, type AppState } from '../src/state'
import { g, NOW, perm, question } from './helpers'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const at = <K extends Kind>(kind: K, body: Body<K>, sid: string): AnyEnvelope => ({ ...makeEnvelope(kind, body, { sid }), ts: NOW }) as AnyEnvelope
const from = (s: AppState, room: string, e: AnyEnvelope): AppState => reduce(s, { type: 'envelope', env: e, now: NOW, room }).state
const session = (name: string, sid: string): AnyEnvelope => at('session', { name, cwd: `/${name}`, state: 'idle', mode: 'auto' }, sid)
const relay = (s: AppState, room: string, status: 'open' | 'closed'): AppState => reduce(s, { type: 'relay', status, room }).state
const presence = (s: AppState, room: string, computers: number): AppState => reduce(s, { type: 'presence', computers, room }).state

/** Laptop (room A) runs two sessions, desktop (room B) one. */
function two(): AppState {
  let s: AppState = { ...initialState(), paired: true, voiceAvailable: true }
  s = presence(relay(s, A, 'open'), A, 1)
  s = presence(relay(s, B, 'open'), B, 1)
  s = from(s, A, session('laptop-1', 'sid-a1'))
  s = from(s, A, session('laptop-2', 'sid-a2'))
  return from(s, B, session('desktop', 'sid-b1'))
}
const names = (s: AppState): string[] => sessionList(s).map(x => x.view.session!.name)

describe('several paired computers', () => {
  test('sessions from every computer are listed together', () => {
    expect(names(two())).toEqual(['desktop', 'laptop-1', 'laptop-2'])
    expect(two().link).toBe('online')
  })

  test('one computer reconnecting does not hide the other computer’s sessions', () => {
    let s = relay(relay(two(), A, 'closed'), A, 'open')
    // Room A's channels have not re-announced yet (laptop-1 stays: it is on screen); room B is untouched.
    expect(s.active).toBe('sid-a1')
    expect(names(s)).toEqual(['desktop', 'laptop-1'])
    s = from(from(s, A, session('laptop-1', 'sid-a1')), A, session('laptop-2', 'sid-a2'))
    expect(names(s)).toEqual(['desktop', 'laptop-1', 'laptop-2'])
  })

  test('a computer leaving its room only re-checks that room', () => {
    const s = presence(two(), B, 0)
    expect(names(s).filter(n => n.startsWith('laptop'))).toEqual(['laptop-1', 'laptop-2'])
    expect(s.link).toBe('online')
  })

  test('commands go to the computer the session is on', () => {
    let s = reduce(two(), { type: 'select_session', sid: 'sid-b1' }).state
    const stop = g(g(s, 'tap').state, 'scroll_down')
    expect(g(stop.state, 'tap').effects).toEqual([{ type: 'send', kind: 'stop', body: {}, sid: 'sid-b1', room: B }])
    s = from(s, A, at('permission', perm(), 'sid-a2'))
    expect(g(s, 'tap').effects).toEqual([{ type: 'send', kind: 'verdict', body: { request_id: 'abcde', behavior: 'deny' }, sid: 'sid-a2', room: A }])
  })

  test('forgetting a computer drops its sessions, cards and questions, and keeps the rest', () => {
    let s = from(two(), A, at('permission', perm(), 'sid-a1'))
    s = from(s, A, at('question', question(), 'sid-a2'))
    s = reduce(s, { type: 'room_removed', room: A }).state
    expect(names(s)).toEqual(['desktop'])
    expect(s.cards).toEqual([])
    expect(s.questions).toEqual([])
    expect(s.screen).toBe('timeline')
    expect(s.active).toBe('sid-b1')
    expect(Object.keys(s.rooms)).toEqual([B])
  })

  test('the status is online while any computer is there', () => {
    let s = presence(two(), A, 0)
    expect(s.link).toBe('online')
    s = presence(s, B, 0)
    expect(s.link).toBe('relay')
    s = relay(relay(s, A, 'closed'), B, 'closed')
    expect(s.link).toBe('offline')
  })
})
