import { describe, expect, test } from 'bun:test'
import { makeEnvelope, type AnyEnvelope, type Body, type Kind } from '@g2cc/protocol'
import { initialState, reduce, sessionList, TOAST_MS, view, type AppState } from '../src/state'
import { frame, g, gs, NOW, perm, question } from './helpers'

const A = 'aaaa-1'
const B = 'bbbb-2'
const at = <K extends Kind>(sid: string, kind: K, body: Body<K>, ts = NOW): AnyEnvelope => ({ ...makeEnvelope(kind, body, { sid }), ts }) as AnyEnvelope
const recv = (s: AppState, e: AnyEnvelope, now = NOW) => reduce(s, { type: 'envelope', env: e, now }).state
const session = (sid: string, name: string, state: Body<'session'>['state'] = 'idle', ts = NOW) => at(sid, 'session', { name, cwd: `/${name}`, state }, ts)

function two(): AppState {
  let s: AppState = { ...initialState(), paired: true, voiceAvailable: true }
  s = recv(s, session(A, 'repo-a'))
  s = recv(s, session(B, 'repo-b', 'idle', NOW + 1))
  return s
}

describe('multiple sessions', () => {
  test('the first session seen is on screen; others keep their own timelines', () => {
    let s = two()
    s = recv(s, at(A, 'event', { type: 'prompt', summary: 'task A', origin: 'local' }))
    s = recv(s, at(B, 'event', { type: 'prompt', summary: 'task B', origin: 'local' }))
    expect(s.active).toBe(A)
    expect(frame(s).timeline).toContain('task A')
    expect(frame(s).timeline).not.toContain('task B')
    expect(view(s, B).entries.map(e => e.text)).toEqual(['task B'])
  })

  test('a reply in another session raises a toast and marks it unread', () => {
    let s = recv(two(), at(B, 'reply', { text: 'Done in B.' }))
    expect(frame(s).header).toBe('◆ repo-b: reply ready')
    expect(view(s, B).unread).toBe(true)
    s = reduce(s, { type: 'tick', now: NOW + TOAST_MS + 1 }).state
    expect(frame(s).header.startsWith('× repo-a · idle')).toBe(true)
    expect(frame(s).header).toContain('◆')
  })

  test('another session waiting for input raises a toast', () => {
    const s = recv(two(), at(B, 'event', { type: 'notify', summary: 'Claude is waiting for your input' }))
    expect(frame(s).header).toBe('◆ repo-b: needs your input')
  })

  test('the menu lists Sessions; choosing one switches and clears unread', () => {
    let s = recv(two(), at(B, 'reply', { text: 'Done in B.' }))
    s = gs(s, 'tap')
    expect(frame(s).overlay!.content.split('\n').at(-1)).toBe('   Sessions (2)')
    s = gs(s, 'scroll_down', 'scroll_down', 'tap') // Sessions
    expect(s.screen).toBe('sessions')
    const list = frame(s).overlay!.content.split('\n')
    expect(list.some(l => l.includes('repo-a · idle (on screen)'))).toBe(true)
    expect(list.some(l => l.includes('repo-b · idle') && l.includes('◆'))).toBe(true)
    const iB = sessionList(s).findIndex(x => x.sid === B)
    s = { ...s, sessionIndex: iB }
    s = gs(s, 'tap')
    expect([s.active, s.screen, view(s, B).unread]).toEqual([B, 'timeline', false])
    expect(frame(s).timeline).toContain('Done in B.')
  })

  test('the menu has no Sessions entry with only one session', () => {
    let s: AppState = { ...initialState(), paired: true }
    s = recv(s, session(A, 'repo-a'))
    expect(frame(gs(s, 'tap')).overlay!.content).not.toContain('Sessions')
  })

  test('stop and prompts go to the session on screen', () => {
    const s = two()
    expect(g(gs(s, 'tap', 'scroll_down'), 'tap').effects).toEqual([{ type: 'send', kind: 'stop', body: {}, sid: A }])
    const review = reduce(gs(s, 'tap', 'tap', 'tap'), { type: 'transcript', attempt: 1, text: 'run it', now: NOW }).state
    expect(g(review, 'tap').effects).toEqual([{ type: 'send', kind: 'prompt', body: { text: 'run it' }, sid: A }])
  })

  test('cards and questions from another session say so, and answer that session', () => {
    let s = recv(two(), at(B, 'permission', perm()))
    expect(frame(s).overlay!.content.split('\n')[0]).toBe('Allow Bash? · repo-b')
    expect(g(s, 'tap').effects).toEqual([{ type: 'send', kind: 'verdict', body: { request_id: 'abcde', behavior: 'deny' }, sid: B }])
    s = recv(two(), at(B, 'question', question()))
    expect(frame(s).overlay!.content.split('\n')[0]).toContain('repo-b asks:')
    expect(g(s, 'tap').effects).toEqual([{ type: 'send', kind: 'answer', body: { question_id: 'q00000001', choice: 'main' }, sid: B }])
  })

  test('an ended session leaves; if it was on screen, the next one takes over', () => {
    let s = recv(two(), session(B, 'repo-b', 'ended', NOW + 5))
    expect(sessionList(s).map(x => x.sid)).toEqual([A])
    s = recv(recv(two(), session(A, 'repo-a', 'ended', NOW + 5)), at(B, 'glance', { text: 'still here' }))
    expect(s.active).toBe(B)
    expect(frame(s).timeline).toContain('still here')
  })
})

describe('stale sessions', () => {
  const open = (s: AppState) => reduce(s, { type: 'relay', status: 'open' }).state
  const OLD = NOW - 30 * 60_000

  test('sessions replayed from history are hidden; ones that re-announce after connect are listed', () => {
    let s = open({ ...initialState(), paired: true })
    s = recv(s, session('dead-1', 'old-a', 'idle', OLD))
    s = recv(s, session('dead-2', 'old-b', 'idle', OLD))
    s = recv(s, session(A, 'repo-a', 'idle', NOW))
    expect(sessionList(s).map(x => x.sid)).toEqual([A])
  })

  test('a stale session on screen hands over to the first live one', () => {
    let s = open({ ...initialState(), paired: true })
    s = recv(s, session('dead-1', 'old-a', 'idle', OLD))
    expect(s.active).toBe('dead-1')
    s = recv(s, session(A, 'repo-a', 'idle', NOW))
    expect(s.active).toBe(A)
  })

  test('a reconnect makes everyone prove they are alive again', () => {
    let s = open(two())
    s = recv(s, session(A, 'repo-a', 'idle', NOW + 2))
    s = recv(s, session(B, 'repo-b', 'idle', NOW + 3))
    s = reduce(s, { type: 'relay', status: 'closed' }).state
    s = open(s)
    s = recv(s, session(A, 'repo-a', 'idle', NOW + 10)) // only A re-announces
    expect(sessionList(s).map(x => x.sid)).toEqual([A])
  })

  test('Clear other sessions keeps only the one on screen', () => {
    let s = gs(two(), 'tap', 'scroll_down', 'scroll_down', 'tap') // menu > Sessions
    const rows = frame(s).overlay!.content.split('\n')
    expect(rows.at(-1)).toBe('   Clear other sessions')
    s = { ...s, sessionIndex: rows.length - 1 }
    s = gs(s, 'tap')
    expect(Object.keys(s.views)).toEqual([A])
    expect(s.screen).toBe('timeline')
    // A cleared session that is still alive comes back with its next envelope.
    s = recv(s, at(B, 'glance', { text: 'back' }))
    expect(sessionList(s).map(x => x.sid).sort()).toEqual([A, B].sort())
  })
})

describe('toasts are hard to miss', () => {
  test('last 8 s at full brightness with a pulsing marker', () => {
    expect(TOAST_MS).toBe(8_000)
    const s = recv(two(), at(B, 'reply', { text: 'Done in B.' }))
    const headerOf = (t: number) => reduce(s, { type: 'tick', now: t }).state
    const h0 = frame(headerOf(NOW)).header
    const h1 = frame(headerOf(NOW + 500)).header
    expect(h0.slice(1)).toBe(h1.slice(1))
    expect(new Set([h0[0], h1[0]])).toEqual(new Set(['◆', '◇']))
  })
})
