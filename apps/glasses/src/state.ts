// App state as a pure reducer: (state, message) -> (new state, effects).
// No SDK or network access here, so it is fully unit-testable.

import type { AnyEnvelope, Body } from '@g2cc/protocol'
import { resolveGesture, type Gesture, type GestureMap, type Screen } from './gestures'
import { paginate } from './layout'
import { toPlainText } from './plain'
import { matchOption, parseVoice } from './voice'

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
  id: 'review' | 'review_question' | 'talk' | 'stop'
  label: string
  available: boolean
}

/** Feed menu (feed tap). Talk arrives with voice prompts in Phase 6. */
export function menuItems(s: AppState): MenuItem[] {
  const review: MenuItem[] = [
    ...(s.cards[0] ? [{ id: 'review' as const, label: `Review: ${s.cards[0].tool_name}`, available: true }] : []),
    ...(s.questions[0] ? [{ id: 'review_question' as const, label: 'Review question', available: true }] : []),
  ]
  const talk: MenuItem = { id: 'talk', label: s.voiceAvailable ? 'Talk' : 'Talk (no Groq key)', available: s.voiceAvailable }
  return [...review, talk, { id: 'stop', label: 'Stop Claude', available: true }]
}

export interface VoiceState {
  phase: 'idle' | 'listening' | 'transcribing' | 'review' | 'error'
  /** Increments per recording, so a late transcript from a cancelled one is ignored. */
  attempt: number
  text?: string
  error?: string
}

/** The mic is on exactly while the voice screen is listening; main syncs the bridge to this. */
export function micWanted(s: AppState): boolean {
  return s.screen === 'voice' && s.voice.phase === 'listening'
}

export type PermissionCard = Body<'permission'> & { ts: number }
export type QuestionCard = Body<'question'> & { ts: number }

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
  screen: Extract<Screen, 'feed' | 'reply' | 'card' | 'voice'> | 'menu' | 'question'
  /** Questions from the ask tool, oldest first. Permission cards outrank them. */
  questions: readonly QuestionCard[]
  questionIndex: number
  questionShownAt: number
  voice: VoiceState
  /** A Groq key is configured. */
  voiceAvailable: boolean
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
  | { type: 'config'; voiceAvailable: boolean }
  | { type: 'transcript'; attempt: number; text: string; now: number }
  | { type: 'transcript_error'; attempt: number; message: string }
  | { type: 'voice_limit' }

export type Effect =
  | { type: 'exit' }
  | { type: 'send'; kind: 'stop'; body: Record<string, never> }
  | { type: 'send'; kind: 'verdict'; body: Body<'verdict'> }
  | { type: 'send'; kind: 'prompt'; body: Body<'prompt'> }
  | { type: 'send'; kind: 'answer'; body: Body<'answer'> }

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
    voice: { phase: 'idle', attempt: 0 },
    questions: [],
    questionIndex: 0,
    questionShownAt: 0,
    voiceAvailable: false,
    stopPending: false,
    replyPage: 0,
    feedOffset: 0,
  }
}

/**
 * Screen priority (CLAUDE.md): permission card > question > voice > reply > feed,
 * and the menu is the user's own action. Live replies and new prompts only
 * move the user between the passive screens; they never bury anything above.
 */
const isPassive = (screen: AppState['screen']): boolean => screen === 'feed' || screen === 'reply'

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
  if (b.type !== 'prompt' || now - env.ts > FRESH_MS) return next
  const cleared = { ...next, stopPending: false }
  return isPassive(s.screen) ? { ...cleared, screen: 'feed', feedOffset: 0 } : cleared
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
      return fresh && isPassive(s.screen) ? { ...s, reply, screen: 'reply', replyPage: 0 } : { ...s, reply }
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
    case 'question': {
      if (now - env.ts > FRESH_MS) return s
      if (s.questions.some(q => q.question_id === env.body.question_id)) return s
      const next = { ...s, questions: [...s.questions, { ...env.body, ts: env.ts }] }
      // Behind a permission card or an existing question, it waits its turn.
      return s.screen === 'card' || s.screen === 'question' ? next : showQuestion(next, now, 0)
    }
    default:
      return s
  }
}

function showQuestion(s: AppState, now: number, index: number): AppState {
  const voice: VoiceState = s.voice.phase === 'listening' ? { ...s.voice, phase: 'idle' } : s.voice
  return { ...s, voice, screen: 'question', questionIndex: index, questionShownAt: now }
}

function showCard(s: AppState, now: number): AppState {
  // A card preempts recording (the mic goes off). A transcription already in
  // flight continues, so "approve" or "deny" said just before can answer it.
  const voice: VoiceState = s.voice.phase === 'listening' ? { ...s.voice, phase: 'idle' } : s.voice
  return { ...s, voice, screen: 'card', cardChoice: 'deny', cardShownAt: now }
}

/** Where to go when a card closes: a pending voice review, then a waiting question, else the feed. */
function afterCard(s: AppState, now: number): AppState {
  if (s.voice.phase === 'review' || s.voice.phase === 'error') return { ...s, screen: 'voice' }
  if (s.questions[0]) return showQuestion(s, now, 0)
  return { ...s, screen: 'feed' }
}

/** Removes a card; if it was on screen, shows the next one or returns to the feed. */
function dropCard(s: AppState, requestId: string, now: number): AppState {
  const wasShown = s.screen === 'card' && s.cards[0]?.request_id === requestId
  const cards = s.cards.filter(c => c.request_id !== requestId)
  if (cards.length === s.cards.length) return s
  const next = { ...s, cards }
  if (!wasShown) return next
  return cards.length ? showCard(next, now) : afterCard(next, now)
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
      if (s.screen === 'question') return done({ ...s, questionIndex: Math.max(0, s.questionIndex - 1) })
      if (s.screen === 'card') return done({ ...s, cardChoice: 'allow' })
      return done(s.screen === 'menu' ? { ...s, menuIndex: Math.max(0, s.menuIndex - 1) } : s)
    case 'card.next':
      if (s.screen === 'question') {
        const last = (s.questions[0]?.options.length ?? 1) - 1
        return done({ ...s, questionIndex: Math.min(last, s.questionIndex + 1) })
      }
      if (s.screen === 'card') return done({ ...s, cardChoice: 'deny' })
      return done(s.screen === 'menu' ? { ...s, menuIndex: Math.min(menuItems(s).length - 1, s.menuIndex + 1) } : s)
    case 'card.confirm':
      if (s.screen === 'question') return confirmQuestion(s, now)
      return s.screen === 'card' ? confirmCard(s, now) : confirmMenu(s, now)
    case 'voice.send':
    case 'voice.cancel':
      return s.screen === 'voice' ? onVoiceGesture(s, action) : done(s)
    case 'voice.start':
      return done(s.voiceAvailable ? startListening(s) : s)
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

function confirmQuestion(s: AppState, now: number): Result {
  const q = s.questions[0]
  const choice = q?.options[s.questionIndex]
  if (!q || choice === undefined || now - s.questionShownAt < CARD_GUARD_MS) return done(s)
  const rest = { ...s, questions: s.questions.slice(1) }
  const next = rest.questions[0] ? showQuestion(rest, now, 0) : { ...rest, screen: 'feed' as const }
  return done(next, [{ type: 'send', kind: 'answer', body: { question_id: q.question_id, choice } }])
}

function confirmMenu(s: AppState, now: number): Result {
  if (s.screen !== 'menu') return done(s)
  switch (menuItems(s)[s.menuIndex]?.id) {
    case 'review':
      return done(showCard(s, now))
    case 'review_question':
      return done(showQuestion(s, now, 0))
    case 'stop':
      return done({ ...s, screen: 'feed', stopPending: true }, [{ type: 'send', kind: 'stop', body: {} }])
    case 'talk':
      return done(s.voiceAvailable ? startListening(s) : s)
    default:
      return done(s)
  }
}

function startListening(s: AppState): AppState {
  return { ...s, screen: 'voice', voice: { phase: 'listening', attempt: s.voice.attempt + 1 } }
}

const voiceIdle = (s: AppState): AppState => ({
  ...s,
  voice: { phase: 'idle', attempt: s.voice.attempt },
  screen: s.screen === 'voice' ? 'feed' : s.screen,
})

const voiceError = (s: AppState, error: string): AppState => ({
  ...s,
  voice: { phase: 'error', attempt: s.voice.attempt, error },
})

function onVoiceGesture(s: AppState, action: 'voice.send' | 'voice.cancel'): Result {
  if (action === 'voice.cancel') return done(voiceIdle(s))
  switch (s.voice.phase) {
    case 'listening':
      return done({ ...s, voice: { ...s.voice, phase: 'transcribing' } })
    case 'review': {
      const text = s.voice.text ?? ''
      return done(voiceIdle(s), text ? [{ type: 'send', kind: 'prompt', body: { text } }] : [])
    }
    case 'error':
      return done(startListening(s))
    default:
      return done(s) // transcribing: wait
  }
}

function onTranscript(s: AppState, text: string, now: number): Result {
  const cmd = parseVoice(text)
  switch (cmd.type) {
    case 'stop':
      return done({ ...voiceIdle(s), stopPending: true }, [{ type: 'send', kind: 'stop', body: {} }])
    case 'cancel':
      return done(voiceIdle(s))
    case 'approve':
    case 'deny': {
      const card = s.cards[0]
      if (!card || s.screen !== 'card') return done(voiceError({ ...s, screen: 'voice' }, 'No approval is waiting'))
      const behavior = cmd.type === 'approve' ? 'allow' : 'deny'
      const next = dropCard({ ...s, voice: { phase: 'idle', attempt: s.voice.attempt } }, card.request_id, now)
      return done(next, [{ type: 'send', kind: 'verdict', body: { request_id: card.request_id, behavior } }])
    }
    case 'empty':
      return done(voiceError(s, "Didn't catch that"))
    case 'prompt': {
      // With a question waiting, a spoken option selects it (a tap still confirms).
      const q = s.questions[0]
      const option = q && s.screen !== 'card' ? matchOption(cmd.text, q.options) : null
      if (option !== null) return done(showQuestion({ ...s, voice: { phase: 'idle', attempt: s.voice.attempt } }, now, option))
      return done({ ...s, voice: { phase: 'review', attempt: s.voice.attempt, text: cmd.text } })
    }
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
    case 'config':
      return done({ ...s, voiceAvailable: msg.voiceAvailable })
    case 'transcript':
      if (msg.attempt !== s.voice.attempt || s.voice.phase !== 'transcribing') return done(s)
      return onTranscript(s, msg.text, msg.now)
    case 'transcript_error':
      if (msg.attempt !== s.voice.attempt || s.voice.phase !== 'transcribing') return done(s)
      return done(voiceError(s, msg.message))
    case 'voice_limit':
      return done(s.voice.phase === 'listening' ? { ...s, voice: { ...s.voice, phase: 'transcribing' } } : s)
  }
}
