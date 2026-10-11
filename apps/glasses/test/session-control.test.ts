// Sessions from the phone view: switch the glasses to one, disconnect one
// (this phone stops showing it), and reconnect it later.

import { describe, expect, test } from 'bun:test'
import { makeEnvelope, type AnyEnvelope, type Body, type Kind } from '@g2cc/protocol'
import { initialState, reduce, sessionList, view, type AppState } from '../src/state'
import { NOW, perm, question } from './helpers'

const A = 'aaaa-1'
const B = 'bbbb-2'
const at = <K extends Kind>(sid: string, kind: K, body: Body<K>, ts = NOW): AnyEnvelope => ({ ...makeEnvelope(kind, body, { sid }), ts }) as AnyEnvelope
const recv = (s: AppState, e: AnyEnvelope, now = NOW) => reduce(s, { type: 'envelope', env: e, now }).state
const session = (sid: string, name: string, state: Body<'session'>['state'] = 'idle', ts = NOW) => at(sid, 'session', { name, cwd: `/${name}`, state }, ts)

function two(): AppState {
  let s: AppState = { ...initialState(), paired: true }
  s = recv(s, session(A, 'repo-a'))
  s = recv(s, session(B, 'repo-b', 'idle', NOW + 1))
  return s
}

describe('sessions from the phone', () => {
  test('select puts a session on the glasses and clears its unread mark', () => {
    let s = recv(two(), at(B, 'reply', { text: 'Done in B.' }))
    expect(view(s, B).unread).toBe(true)
    s = reduce(s, { type: 'select_session', sid: B }).state
    expect([s.active, view(s, B).unread]).toEqual([B, false])
    // An unknown session is ignored.
    expect(reduce(s, { type: 'select_session', sid: 'nope' }).state.active).toBe(B)
  })

  test('disconnect hides a session, drops its cards and questions, and saves the list', () => {
    let s = two()
    s = recv(s, at(B, 'permission', perm()))
    s = recv(s, at(B, 'question', question()))
    const r = reduce(s, { type: 'mute_session', sid: B })
    s = r.state
    expect(sessionList(s).map(x => x.sid)).toEqual([A])
    expect([s.cards.length, s.questions.length, s.screen]).toEqual([0, 0, 'timeline'])
    expect(s.muted).toEqual([{ sid: B, name: 'repo-b' }])
    expect(r.effects).toEqual([{ type: 'save_muted', sessions: [{ sid: B, name: 'repo-b' }] }])
  })

  test('a disconnected session stays hidden: its updates, cards and questions are ignored', () => {
    let s = reduce(two(), { type: 'mute_session', sid: B }).state
    s = recv(s, session(B, 'repo-b', 'working', NOW + 5))
    s = recv(s, at(B, 'permission', perm()))
    s = recv(s, at(B, 'question', question()))
    expect(sessionList(s).map(x => x.sid)).toEqual([A])
    expect([s.cards.length, s.questions.length]).toEqual([0, 0])
  })

  test('disconnecting the session on screen moves the glasses to another one', () => {
    const s = reduce(two(), { type: 'mute_session', sid: A }).state
    expect(s.active).toBe(B)
  })

  test('reconnect shows it again and asks every channel to re-announce', () => {
    let s = reduce(two(), { type: 'mute_session', sid: B }).state
    const r = reduce(s, { type: 'unmute_session', sid: B })
    s = r.state
    expect(s.muted).toEqual([])
    expect(r.effects).toEqual([{ type: 'save_muted', sessions: [] }, { type: 'resync' }])
    s = recv(s, session(B, 'repo-b', 'idle', NOW + 5))
    expect(sessionList(s).map(x => x.sid)).toEqual([A, B])
  })

  test('a disconnected session that ends leaves the list', () => {
    const s = reduce(two(), { type: 'mute_session', sid: B }).state
    const r = reduce(s, { type: 'envelope', env: session(B, 'repo-b', 'ended', NOW + 5), now: NOW + 5 })
    expect(r.state.muted).toEqual([])
    expect(r.effects).toEqual([{ type: 'save_muted', sessions: [] }])
  })

  test('the saved list loads, and survives unpairing', () => {
    let s = reduce(initialState(), { type: 'muted', sessions: [{ sid: B, name: 'repo-b' }] }).state
    s = reduce({ ...s, paired: true }, { type: 'paired', paired: false }).state
    expect(s.muted).toEqual([{ sid: B, name: 'repo-b' }])
  })
})
