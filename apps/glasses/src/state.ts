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

/** Taps this soon after a permission card appears are ignored (it may have preempted another tap). */
export const CARD_GUARD_MS = 500

export interface MenuItem {
  id: 'review' | 'talk' | 'stop'
  label: string
  available: boolean
}

/** Feed menu (feed tap). Talk arrives with voice prompts in Phase 6. */
export function menuItems(s: AppState): MenuItem[] {
  const review: MenuItem[] = s.cards[0] ? [{ id: 'review', label: `Review: ${s.cards[0].tool_name}`, available: true }] : []
  return [...review, { id: 'talk', label: 'Talk', available: false }, { id: 'stop', label: 'Stop Claude', available: true }]
}

export type PermissionCard = Body<'permission'> & { ts: number }

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
  screen: Extract<Screen, 'feed' | 'reply' | 'card'> | 'menu'
  menuIndex: number
  /** Pending permission requests, oldest first. The first one is on screen. */
  cards: readonly PermissionCard[]
  /** Starts on deny, so a stray tap never approves anything. */
  cardChoice: 'allow' | 'deny'
  cardShownAt: number
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
  | { type: 'gesture'; gesture: Gesture; map: GestureMap; now?: number }
  | { type: 'paired'; paired: boolean }

export type Effect =
  | { type: 'exit' }
  | { type: 'send'; kind: 'stop'; body: Record<string, never> }
  | { type: 'send'; kind: 'verdict'; body: Body<'verdict'> }

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
    cards: [],
    cardChoice: 'deny',
    cardShownAt: 0,
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
    case 'permission': {
      // Stale cards come from history replay; the channel re-sends live ones fresh on connect.
      if (now - env.ts > FRESH_MS) return s
      if (s.cards.some(c => c.request_id === env.body.request_id)) return s
      const cards = [...s.cards, { ...env.body, ts: env.ts }]
      return s.screen === 'card' ? { ...s, cards } : showCard({ ...s, cards }, now)
    }
    case 'permission_resolved':
      return dropCard(s, env.body.request_id, now)
    default:
      // question: Phase 7.
      return s
  }
}

function showCard(s: AppState, now: number): AppState {
  return { ...s, screen: 'card', cardChoice: 'deny', cardShownAt: now }
}

/** Removes a card; if it was on screen, shows the next one or returns to the feed. */
function dropCard(s: AppState, requestId: string, now: number): AppState {
  const wasShown = s.screen === 'card' && s.cards[0]?.request_id === requestId
  const cards = s.cards.filter(c => c.request_id !== requestId)
  if (cards.length === s.cards.length) return s
  const next = { ...s, cards }
  if (!wasShown) return next
  return cards.length ? showCard(next, now) : { ...next, screen: 'feed' }
}

function onGesture(s: AppState, gesture: Gesture, map: GestureMap, now: number): Result {
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
      if (s.screen === 'card') return done({ ...s, cardChoice: 'allow' })
      return done(s.screen === 'menu' ? { ...s, menuIndex: Math.max(0, s.menuIndex - 1) } : s)
    case 'card.next':
      if (s.screen === 'card') return done({ ...s, cardChoice: 'deny' })
      return done(s.screen === 'menu' ? { ...s, menuIndex: Math.min(menuItems(s).length - 1, s.menuIndex + 1) } : s)
    case 'card.confirm':
      return s.screen === 'card' ? confirmCard(s, now) : confirmMenu(s, now)
    default:
      // 'none', and actions for screens added in later phases (voice, cards).
      return done(s)
  }
}

function confirmCard(s: AppState, now: number): Result {
  const card = s.cards[0]
  if (!card || now - s.cardShownAt < CARD_GUARD_MS) return done(s)
  const verdict: Effect = { type: 'send', kind: 'verdict', body: { request_id: card.request_id, behavior: s.cardChoice } }
  return done(dropCard(s, card.request_id, now), [verdict])
}

function confirmMenu(s: AppState, now: number): Result {
  if (s.screen !== 'menu') return done(s)
  switch (menuItems(s)[s.menuIndex]?.id) {
    case 'review':
      return done(showCard(s, now))
    case 'stop':
      return done({ ...s, screen: 'feed', stopPending: true }, [{ type: 'send', kind: 'stop', body: {} }])
    default:
      return done(s) // Talk: not available yet
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
      // Without a clock (tests of non-card screens) the card guard is not applied.
      return onGesture(s, msg.gesture, msg.map, msg.now ?? Number.POSITIVE_INFINITY)
    case 'paired':
      return done({ ...s, paired: msg.paired })
  }
}
