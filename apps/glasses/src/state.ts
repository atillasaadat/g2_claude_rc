// App state as a pure reducer: (state, message) -> (new state, effects).
// No SDK or network access here, so it is fully unit-testable.

import type { AnyEnvelope, Body } from '@g2cc/protocol'
import { resolveGesture, type Gesture, type GestureMap, type Screen } from './gestures'
import { paginate } from './layout'
import { toPlainText } from './plain'

export const MAX_EVENTS = 50
export const FEED_LINES = 4
/**
 * Envelopes newer than this are live: a reply opens the reply screen and a
 * prompt returns to the feed. Older ones come from history replay.
 */
export const FRESH_MS = 60_000

export type Link = 'offline' | 'relay' | 'online'

/** Feed menu (feed tap). Talk arrives with voice prompts in Phase 6. */
export const MENU_ITEMS = [
  { id: 'talk', label: 'Talk', available: false },
  { id: 'stop', label: 'Stop Claude', available: true },
] as const

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
  screen: Extract<Screen, 'feed' | 'reply'> | 'menu'
  menuIndex: number
  /** A stop was sent and the channel has not yet reported idle or stopped. */
  stopPending: boolean
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

export type Effect = { type: 'exit' } | { type: 'send'; kind: 'stop'; body: Record<string, never> }

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
    menuIndex: 0,
    stopPending: false,
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

function onEvent(s: AppState, env: Extract<AnyEnvelope, { kind: 'event' }>, now: number): AppState {
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
  const next = { ...s, events: appendEvent(s.events, line) }
  // A new turn takes the user back to the live feed. Replayed history does not.
  return b.type === 'prompt' && now - env.ts <= FRESH_MS ? { ...next, screen: 'feed', feedOffset: 0, stopPending: false } : next
}

function onEnvelope(s: AppState, env: AnyEnvelope, now: number): AppState {
  switch (env.kind) {
    case 'session':
      // History may replay older session frames after newer ones.
      if (env.ts < s.sessionTs) return s
      return {
        ...s,
        session: env.body,
        sessionTs: env.ts,
        stopPending: s.stopPending && env.body.state !== 'idle' && env.body.state !== 'stopped',
      }
    case 'event':
      return onEvent(s, env, now)
    case 'glance':
      return { ...s, glance: env.body.text }
    case 'reply': {
      if (s.reply && env.ts < s.reply.ts) return s
      const text = toPlainText(env.body.text)
      const reply = { text, ts: env.ts, pages: paginate(text) }
      const fresh = now - env.ts <= FRESH_MS
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
    case 'menu.open':
      return done({ ...s, screen: 'menu', menuIndex: 0 })
    case 'card.prev':
      return done(s.screen === 'menu' ? { ...s, menuIndex: Math.max(0, s.menuIndex - 1) } : s)
    case 'card.next':
      return done(s.screen === 'menu' ? { ...s, menuIndex: Math.min(MENU_ITEMS.length - 1, s.menuIndex + 1) } : s)
    case 'card.confirm': {
      if (s.screen !== 'menu') return done(s)
      const item = MENU_ITEMS[s.menuIndex]
      if (item?.id !== 'stop') return done(s) // Talk: not available yet
      return done({ ...s, screen: 'feed', stopPending: true }, [{ type: 'send', kind: 'stop', body: {} }])
    }
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
