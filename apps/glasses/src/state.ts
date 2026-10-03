// App state as a pure reducer: (state, message) -> (new state, effects).
// No SDK or network access here, so it is fully unit-testable.

import type { AnyEnvelope, Body } from '@g2cc/protocol'
import { resolveGesture, type Gesture, type GestureMap, type Screen } from './gestures'
import { paginate } from './layout'

export const MAX_EVENTS = 50
export const FEED_LINES = 4
/** A reply newer than this opens the reply screen; older ones come from history replay. */
export const REPLY_FRESH_MS = 60_000

export type Link = 'offline' | 'relay' | 'online'

export interface FeedLine {
  id: string
  ts: number
  type: 'prompt' | 'tool' | 'notify'
  summary: string
  tool?: string
  result?: string
  origin?: 'glasses' | 'local'
}

export interface AppState {
  paired: boolean
  relayOpen: boolean
  computers: number
  link: Link
  session?: Body<'session'>
  sessionTs: number
  events: readonly FeedLine[]
  glance?: string
  reply?: { text: string; ts: number; pages: readonly string[] }
  screen: Extract<Screen, 'feed' | 'reply'>
  replyPage: number
  /** How many events back from the newest the feed is scrolled. */
  feedOffset: number
}

export type Msg =
  | { type: 'envelope'; env: AnyEnvelope; now: number }
  | { type: 'relay'; status: 'connecting' | 'open' | 'closed' }
  | { type: 'presence'; computers: number }
  | { type: 'gesture'; gesture: Gesture; map: GestureMap }
  | { type: 'paired'; paired: boolean }

export type Effect = { type: 'exit' }

export interface Result {
  state: AppState
  effects: Effect[]
}

export function initialState(): AppState {
  return {
    paired: false,
    relayOpen: false,
    computers: 0,
    link: 'offline',
    sessionTs: 0,
    events: [],
    screen: 'feed',
    replyPage: 0,
    feedOffset: 0,
  }
}

const link = (relayOpen: boolean, computers: number): Link => (!relayOpen ? 'offline' : computers > 0 ? 'online' : 'relay')
const done = (state: AppState, effects: Effect[] = []): Result => ({ state, effects })

function appendEvent(events: readonly FeedLine[], line: FeedLine): readonly FeedLine[] {
  const next = [...events, line]
  return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
}

function onEvent(s: AppState, env: Extract<AnyEnvelope, { kind: 'event' }>): AppState {
  const b = env.body
  if (b.type === 'tool_end') {
    // Merge into the most recent unfinished start of the same tool: one line per tool call.
    const idx = s.events.findLastIndex(e => e.type === 'tool' && e.tool === b.tool && e.result === undefined)
    if (idx >= 0) {
      const events = s.events.map((e, i) => (i === idx ? { ...e, result: b.summary } : e))
      return { ...s, events }
    }
    return { ...s, events: appendEvent(s.events, { id: env.id, ts: env.ts, type: 'tool', tool: b.tool, summary: b.tool ?? '', result: b.summary }) }
  }
  const line: FeedLine =
    b.type === 'tool_start'
      ? { id: env.id, ts: env.ts, type: 'tool', tool: b.tool, summary: b.summary }
      : b.type === 'prompt'
        ? { id: env.id, ts: env.ts, type: 'prompt', summary: b.summary, origin: b.origin }
        : { id: env.id, ts: env.ts, type: 'notify', summary: b.summary }
  return { ...s, events: appendEvent(s.events, line) }
}

function onEnvelope(s: AppState, env: AnyEnvelope, now: number): AppState {
  switch (env.kind) {
    case 'session':
      // History may replay older session frames after newer ones.
      return env.ts < s.sessionTs ? s : { ...s, session: env.body, sessionTs: env.ts }
    case 'event':
      return onEvent(s, env)
    case 'glance':
      return { ...s, glance: env.body.text }
    case 'reply': {
      if (s.reply && env.ts < s.reply.ts) return s
      const reply = { text: env.body.text, ts: env.ts, pages: paginate(env.body.text) }
      const fresh = now - env.ts <= REPLY_FRESH_MS
      return fresh ? { ...s, reply, screen: 'reply', replyPage: 0 } : { ...s, reply }
    }
    default:
      // permission, permission_resolved, question: later phases.
      return s
  }
}

function onGesture(s: AppState, gesture: Gesture, map: GestureMap): Result {
  const action = resolveGesture(map, s.screen, gesture)
  const maxOffset = Math.max(0, s.events.length - FEED_LINES)
  const lastPage = Math.max(0, (s.reply?.pages.length ?? 1) - 1)
  switch (action) {
    case 'app.exit':
      return done(s, [{ type: 'exit' }])
    case 'feed.older':
      return done({ ...s, feedOffset: Math.min(maxOffset, s.feedOffset + 1) })
    case 'feed.newer':
      if (s.feedOffset > 0) return done({ ...s, feedOffset: s.feedOffset - 1 })
      return done(s.reply ? { ...s, screen: 'reply', replyPage: 0 } : s)
    case 'reply.open':
      return done(s.reply ? { ...s, screen: 'reply', replyPage: 0 } : s)
    case 'page.prev':
      return done({ ...s, replyPage: Math.max(0, s.replyPage - 1) })
    case 'page.next':
      return done({ ...s, replyPage: Math.min(lastPage, s.replyPage + 1) })
    case 'nav.back':
      return done({ ...s, screen: 'feed' })
    default:
      // 'none', and actions for screens added in later phases (voice, cards).
      return done(s)
  }
}

export function reduce(s: AppState, msg: Msg): Result {
  switch (msg.type) {
    case 'envelope':
      return done(onEnvelope(s, msg.env, msg.now))
    case 'relay': {
      const relayOpen = msg.status === 'open'
      const computers = relayOpen ? s.computers : 0
      return done({ ...s, relayOpen, computers, link: link(relayOpen, computers) })
    }
    case 'presence':
      return done({ ...s, computers: msg.computers, link: link(s.relayOpen, msg.computers) })
    case 'gesture':
      return onGesture(s, msg.gesture, msg.map)
    case 'paired':
      return done({ ...s, paired: msg.paired })
  }
}
