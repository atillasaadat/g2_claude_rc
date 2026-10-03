// App state as a pure reducer: (state, message) -> (new state, effects).
// No SDK or network access here, so it is fully unit-testable.
//
// Each Claude Code session (envelope sid) has its own view: header info,
// timeline, scroll position. One view is active; the others raise toasts.
// Overlays (menu, sessions, permission card, question, voice) sit above the
// active timeline. Priority (CLAUDE.md): permission card > question > voice >
// timeline; the menu and session list are the user's own actions.

import type { AnyEnvelope, Body } from '@g2cc/protocol'
import { resolveGesture, type Gesture, type GestureMap } from './gestures'
import { TIMELINE_LINES } from './layout'
import { toPlainText } from './plain'
import { buildTimeline, type TimelineEntry } from './timeline'
import { matchOption, parseVoice } from './voice'

export const MAX_ENTRIES = 80
/** Envelopes newer than this are live; older ones come from history replay. */
export const FRESH_MS = 60_000
/** Taps this soon after a card appears are ignored (it may have preempted another tap). */
export const CARD_GUARD_MS = 500
/** Lines moved per swipe (touchpad or R1 ring). */
export const SCROLL_STEP = 3
/** Overlays fade in over this long. */
export const FADE_MS = 450
/** Toasts about other sessions stay in the header this long. */
export const TOAST_MS = 5_000

export type Link = 'offline' | 'relay' | 'online'
export type ScreenId = 'timeline' | 'menu' | 'sessions' | 'card' | 'question' | 'voice'

export interface MenuItem {
  id: 'review' | 'review_question' | 'talk' | 'stop' | 'sessions'
  label: string
  available: boolean
}

export interface VoiceState {
  phase: 'idle' | 'listening' | 'transcribing' | 'review' | 'error'
  /** Increments per recording, so a late transcript from a cancelled one is ignored. */
  attempt: number
  /** Live partial transcript while listening. */
  partial?: string
  text?: string
  error?: string
}

/** One Claude Code session as the glasses see it. */
export interface SessionView {
  session?: Body<'session'>
  sessionTs: number
  entries: readonly TimelineEntry[]
  /** Lines scrolled up from the newest line; 0 means following live. */
  fromBottom: number
  /** A stop was sent and the channel has not yet reported idle or stopped. */
  stopPending: boolean
  lastSeen: number
  /** Something happened here while another session was active. */
  unread: boolean
}

export type PermissionCard = Body<'permission'> & { ts: number; sid: string }
export type QuestionCard = Body<'question'> & { ts: number; sid: string }

export interface AppState {
  paired: boolean
  relayOpen: boolean
  computers: number
  link: Link
  /** Views by session id ('' for envelopes without one). */
  views: Readonly<Record<string, SessionView>>
  active: string
  screen: ScreenId
  /** Animation clock (ms), advanced by ticks while something animates. */
  clock: number
  overlaySince: number
  menuIndex: number
  sessionIndex: number
  /** Pending permission requests, oldest first. The first one is on screen. */
  cards: readonly PermissionCard[]
  /** Starts on deny, so a stray tap never approves anything. */
  cardChoice: 'allow' | 'deny'
  cardShownAt: number
  /** Questions from the ask tool, oldest first. Permission cards outrank them. */
  questions: readonly QuestionCard[]
  questionIndex: number
  questionShownAt: number
  voice: VoiceState
  /** A Groq key is configured. */
  voiceAvailable: boolean
  toast?: { text: string; until: number }
}

export type Msg =
  | { type: 'envelope'; env: AnyEnvelope; now: number }
  | { type: 'relay'; status: 'connecting' | 'open' | 'closed' }
  | { type: 'presence'; computers: number }
  | { type: 'gesture'; gesture: Gesture; map: GestureMap; now?: number }
  | { type: 'paired'; paired: boolean }
  | { type: 'config'; voiceAvailable: boolean }
  | { type: 'transcript'; attempt: number; text: string; now: number }
  | { type: 'partial'; attempt: number; text: string }
  | { type: 'transcript_error'; attempt: number; message: string }
  | { type: 'voice_limit' }
  | { type: 'tick'; now: number }

/** Commands name their target session (sid), since several share the relay room. */
export type Effect =
  | { type: 'exit' }
  | { type: 'send'; kind: 'stop'; body: Record<string, never>; sid: string }
  | { type: 'send'; kind: 'verdict'; body: Body<'verdict'>; sid: string }
  | { type: 'send'; kind: 'prompt'; body: Body<'prompt'>; sid: string }
  | { type: 'send'; kind: 'answer'; body: Body<'answer'>; sid: string }

export interface Result {
  state: AppState
  effects: Effect[]
}

const EMPTY_VIEW: SessionView = { sessionTs: 0, entries: [], fromBottom: 0, stopPending: false, lastSeen: 0, unread: false }

export function initialState(): AppState {
  return {
    paired: false,
    relayOpen: false,
    computers: 0,
    link: 'offline',
    views: {},
    active: '',
    screen: 'timeline',
    clock: 0,
    overlaySince: 0,
    menuIndex: 0,
    sessionIndex: 0,
    cards: [],
    cardChoice: 'deny',
    cardShownAt: 0,
    questions: [],
    questionIndex: 0,
    questionShownAt: 0,
    voice: { phase: 'idle', attempt: 0 },
    voiceAvailable: false,
  }
}

// Views ------------------------------------------------------------------

export const view = (s: AppState, sid: string = s.active): SessionView => s.views[sid] ?? EMPTY_VIEW
const withView = (s: AppState, sid: string, v: SessionView): AppState => ({ ...s, views: { ...s.views, [sid]: v } })
const mapActive = (s: AppState, f: (v: SessionView) => SessionView): AppState => withView(s, s.active, f(view(s)))

/** Live sessions, most recently active first. */
export function sessionList(s: AppState): Array<{ sid: string; view: SessionView }> {
  return Object.entries(s.views)
    .filter(([, v]) => v.session)
    .sort(([, a], [, b]) => b.lastSeen - a.lastSeen)
    .map(([sid, v]) => ({ sid, view: v }))
}

export const sessionName = (s: AppState, sid: string): string => view(s, sid).session?.name ?? 'Claude Code'

export function menuItems(s: AppState): MenuItem[] {
  const sessions = sessionList(s).length
  return [
    ...(s.cards[0] ? [{ id: 'review' as const, label: `Review: ${s.cards[0].tool_name}`, available: true }] : []),
    ...(s.questions[0] ? [{ id: 'review_question' as const, label: 'Review question', available: true }] : []),
    { id: 'talk', label: s.voiceAvailable ? 'Talk' : 'Talk (no Groq key)', available: s.voiceAvailable },
    { id: 'stop', label: 'Stop Claude', available: true },
    ...(sessions > 1 ? [{ id: 'sessions' as const, label: `Sessions (${sessions})`, available: true }] : []),
  ]
}

/** The mic is on exactly while the voice overlay is listening; main syncs the bridge to this. */
export function micWanted(s: AppState): boolean {
  return s.screen === 'voice' && s.voice.phase === 'listening'
}

/** Whether the animation clock needs to tick (dots, pulse, fade, toast). */
export function isAnimating(s: AppState): boolean {
  const v = view(s)
  return (
    v.session?.state === 'working' ||
    v.stopPending ||
    s.voice.phase === 'listening' ||
    s.voice.phase === 'transcribing' ||
    (s.screen !== 'timeline' && s.clock - s.overlaySince < FADE_MS) ||
    (s.toast !== undefined && s.clock < s.toast.until)
  )
}

export const totalLines = (entries: readonly TimelineEntry[]): number => buildTimeline(entries).lines.length
const maxScroll = (entries: readonly TimelineEntry[]): number => Math.max(0, totalLines(entries) - TIMELINE_LINES)

const link = (relayOpen: boolean, computers: number): Link => (!relayOpen ? 'offline' : computers > 0 ? 'online' : 'relay')
const done = (state: AppState, effects: Effect[] = []): Result => ({ state, effects })
const open = (s: AppState, screen: ScreenId, now: number): AppState => ({
  ...s,
  screen,
  overlaySince: s.screen === screen ? s.overlaySince : now,
  clock: Math.max(s.clock, now),
})

/**
 * Replaces a view's entries and keeps it steady: following live stays at the
 * bottom, a scrolled-up view keeps showing the same lines as new ones arrive.
 */
function withEntries(v: SessionView, entries: readonly TimelineEntry[]): SessionView {
  const kept = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries
  if (v.fromBottom === 0) return { ...v, entries: kept }
  const grown = totalLines(kept) - totalLines(v.entries)
  return { ...v, entries: kept, fromBottom: Math.min(maxScroll(kept), Math.max(0, v.fromBottom + grown)) }
}

/** Something worth a look happened in a session that is not on screen. */
function notifyOther(s: AppState, sid: string, what: string, now: number): AppState {
  if (sid === s.active) return s
  const v = view(s, sid)
  return { ...withView(s, sid, { ...v, unread: true }), toast: { text: `◆ ${v.session?.name ?? 'session'}: ${what}`, until: now + TOAST_MS }, clock: Math.max(s.clock, now) }
}

function onEvent(v: SessionView, env: Extract<AnyEnvelope, { kind: 'event' }>, now: number, onTimeline: boolean): SessionView {
  const b = env.body
  if (b.type === 'tool_end') {
    // Merge into the most recent unfinished start of the same tool: one line per tool call.
    const idx = v.entries.findLastIndex(e => e.kind === 'tool' && e.tool === b.tool && e.result === undefined)
    if (idx >= 0) return { ...v, entries: v.entries.map((e, i) => (i === idx ? { ...e, result: b.summary } : e)) }
    return withEntries(v, [...v.entries, { id: env.id, ts: env.ts, kind: 'tool', tool: b.tool, text: b.tool ?? '', result: b.summary }])
  }
  const entry: TimelineEntry =
    b.type === 'tool_start'
      ? { id: env.id, ts: env.ts, kind: 'tool', tool: b.tool, text: b.summary }
      : b.type === 'prompt'
        ? { id: env.id, ts: env.ts, kind: 'prompt', text: b.summary, ...(b.origin ? { origin: b.origin } : {}) }
        : { id: env.id, ts: env.ts, kind: 'notify', text: b.summary }
  const next = withEntries(v, [...v.entries, entry])
  if (b.type !== 'prompt' || now - env.ts > FRESH_MS) return next
  // A new turn: back to live (only from the timeline; overlays are never buried).
  return { ...next, stopPending: false, fromBottom: onTimeline ? 0 : next.fromBottom }
}

function onReply(v: SessionView, env: Extract<AnyEnvelope, { kind: 'reply' }>, now: number): SessionView {
  const entry: TimelineEntry = { id: env.id, ts: env.ts, kind: 'reply', text: toPlainText(env.body.text) }
  const next = withEntries(v, [...v.entries, entry])
  if (v.fromBottom !== 0 || now - env.ts > FRESH_MS) return next
  // Land on the start of a reply that is taller than the view.
  const { lines, starts } = buildTimeline(next.entries)
  const start = starts.get(entry.id) ?? 0
  return { ...next, fromBottom: Math.max(0, lines.length - (start + TIMELINE_LINES)) }
}

/** Removes an ended session; if it was on screen, switches to the most recent other one. */
function endSession(s: AppState, sid: string): AppState {
  const { [sid]: _gone, ...views } = s.views
  const next = { ...s, views }
  if (s.active !== sid) return next
  const [first] = sessionList(next)
  return { ...next, active: first?.sid ?? '' }
}

function onSessionEnvelope(s: AppState, sid: string, env: AnyEnvelope, now: number): AppState {
  const v = view(s, sid)
  const fresh = now - env.ts <= FRESH_MS
  const seen = { ...v, lastSeen: Math.max(v.lastSeen, env.ts) }
  // The first session seen becomes the active one.
  const base = s.active === '' && !s.views[''] ? { ...s, active: sid } : s
  const onTimeline = base.screen === 'timeline' && sid === base.active
  switch (env.kind) {
    case 'session': {
      // History may replay older session frames after newer ones.
      if (env.ts < v.sessionTs) return base
      if (env.body.state === 'ended') return endSession(base, sid)
      const settled = env.body.state === 'idle' || env.body.state === 'stopped'
      return withView(base, sid, { ...seen, session: env.body, sessionTs: env.ts, stopPending: v.stopPending && !settled })
    }
    case 'event': {
      const next = withView(base, sid, onEvent(seen, env, now, onTimeline))
      const needsInput = env.body.type === 'notify' && /waiting for your input|needs your/i.test(env.body.summary)
      return fresh && needsInput ? notifyOther(next, sid, 'needs your input', now) : next
    }
    case 'glance':
      return withView(base, sid, withEntries(seen, [...seen.entries, { id: env.id, ts: env.ts, kind: 'glance', text: env.body.text }]))
    case 'reply': {
      const next = withView(base, sid, onReply(seen, env, now))
      return fresh ? notifyOther(next, sid, 'reply ready', now) : next
    }
    default:
      return base
  }
}

function onEnvelope(s: AppState, env: AnyEnvelope, now: number): AppState {
  const sid = env.sid ?? ''
  switch (env.kind) {
    case 'permission': {
      // Stale cards come from history replay; the channel re-sends live ones fresh on connect.
      if (now - env.ts > FRESH_MS) return s
      if (s.cards.some(c => c.request_id === env.body.request_id)) return s
      const cards = [...s.cards, { ...env.body, ts: env.ts, sid }]
      return s.screen === 'card' ? { ...s, cards } : showCard({ ...s, cards }, now)
    }
    case 'permission_resolved':
      return dropCard(s, env.body.request_id, now)
    case 'question': {
      if (now - env.ts > FRESH_MS) return s
      if (s.questions.some(q => q.question_id === env.body.question_id)) return s
      const next = { ...s, questions: [...s.questions, { ...env.body, ts: env.ts, sid }] }
      // Behind a permission card or an existing question, it waits its turn.
      return s.screen === 'card' || s.screen === 'question' ? next : showQuestion(next, now, 0)
    }
    default:
      return onSessionEnvelope(s, sid, env, now)
  }
}

// Cards and questions -----------------------------------------------------

/** A card or question preempts recording (the mic goes off); a transcription in flight continues. */
const stopListening = (v: VoiceState): VoiceState => (v.phase === 'listening' ? { phase: 'idle', attempt: v.attempt } : v)

function showCard(s: AppState, now: number): AppState {
  return { ...open(s, 'card', now), voice: stopListening(s.voice), cardChoice: 'deny', cardShownAt: now }
}

function showQuestion(s: AppState, now: number, index: number): AppState {
  return { ...open(s, 'question', now), voice: stopListening(s.voice), questionIndex: index, questionShownAt: now }
}

/** Where to go when a card closes: a pending voice review, then a waiting question, else the timeline. */
function afterCard(s: AppState, now: number): AppState {
  if (s.voice.phase === 'review' || s.voice.phase === 'error') return open(s, 'voice', now)
  if (s.questions[0]) return showQuestion(s, now, 0)
  return { ...s, screen: 'timeline' }
}

/** Removes a card; if it was on screen, shows the next one or moves on. */
function dropCard(s: AppState, requestId: string, now: number): AppState {
  const wasShown = s.screen === 'card' && s.cards[0]?.request_id === requestId
  const cards = s.cards.filter(c => c.request_id !== requestId)
  if (cards.length === s.cards.length) return s
  const next = { ...s, cards }
  if (!wasShown) return next
  return cards.length ? showCard(next, now) : afterCard(next, now)
}

function confirmCard(s: AppState, now: number): Result {
  const card = s.cards[0]
  if (!card || now - s.cardShownAt < CARD_GUARD_MS) return done(s)
  const verdict: Effect = { type: 'send', kind: 'verdict', body: { request_id: card.request_id, behavior: s.cardChoice }, sid: card.sid }
  return done(dropCard(s, card.request_id, now), [verdict])
}

function confirmQuestion(s: AppState, now: number): Result {
  const q = s.questions[0]
  const choice = q?.options[s.questionIndex]
  if (!q || choice === undefined || now - s.questionShownAt < CARD_GUARD_MS) return done(s)
  const rest = { ...s, questions: s.questions.slice(1) }
  const next = rest.questions[0] ? showQuestion(rest, now, 0) : { ...rest, screen: 'timeline' as const }
  return done(next, [{ type: 'send', kind: 'answer', body: { question_id: q.question_id, choice }, sid: q.sid }])
}

// Menu, sessions, voice ---------------------------------------------------

const stopActive = (s: AppState): Result =>
  done(mapActive({ ...s, screen: s.screen === 'voice' || s.screen === 'menu' ? 'timeline' : s.screen }, v => ({ ...v, stopPending: true })), [
    { type: 'send', kind: 'stop', body: {}, sid: s.active },
  ])

function startListening(s: AppState, now: number): AppState {
  return { ...open(s, 'voice', now), voice: { phase: 'listening', attempt: s.voice.attempt + 1 } }
}

function confirmMenu(s: AppState, now: number): Result {
  switch (menuItems(s)[s.menuIndex]?.id) {
    case 'review':
      return done(showCard(s, now))
    case 'review_question':
      return done(showQuestion(s, now, 0))
    case 'stop':
      return stopActive(s)
    case 'talk':
      return done(s.voiceAvailable ? startListening(s, now) : s)
    case 'sessions': {
      const index = Math.max(0, sessionList(s).findIndex(x => x.sid === s.active))
      return done({ ...open(s, 'sessions', now), sessionIndex: index })
    }
    default:
      return done(s)
  }
}

function confirmSession(s: AppState): Result {
  const target = sessionList(s)[s.sessionIndex]
  if (!target) return done({ ...s, screen: 'timeline' })
  const switched = { ...s, active: target.sid, screen: 'timeline' as const, toast: undefined }
  return done(withView(switched, target.sid, { ...target.view, unread: false }))
}

const voiceIdle = (s: AppState): AppState => ({
  ...s,
  voice: { phase: 'idle', attempt: s.voice.attempt },
  screen: s.screen === 'voice' ? 'timeline' : s.screen,
})

const voiceError = (s: AppState, error: string): AppState => ({ ...s, voice: { phase: 'error', attempt: s.voice.attempt, error } })

function onVoiceGesture(s: AppState, action: 'voice.send' | 'voice.cancel', now: number): Result {
  if (action === 'voice.cancel') return done(voiceIdle(s))
  switch (s.voice.phase) {
    case 'listening':
      return done({ ...s, voice: { ...s.voice, phase: 'transcribing' } })
    case 'review': {
      const text = s.voice.text ?? ''
      return done(voiceIdle(s), text ? [{ type: 'send', kind: 'prompt', body: { text }, sid: s.active }] : [])
    }
    case 'error':
      return done(startListening(s, now))
    default:
      return done(s) // transcribing: wait
  }
}

function onTranscript(s: AppState, text: string, now: number): Result {
  const cmd = parseVoice(text)
  switch (cmd.type) {
    case 'stop':
      return stopActive(voiceIdle(s))
    case 'cancel':
      return done(voiceIdle(s))
    case 'approve':
    case 'deny': {
      const card = s.cards[0]
      if (!card || s.screen !== 'card') return done(voiceError(open(s, 'voice', now), 'No approval is waiting'))
      const behavior = cmd.type === 'approve' ? 'allow' : 'deny'
      const next = dropCard({ ...s, voice: { phase: 'idle', attempt: s.voice.attempt } }, card.request_id, now)
      return done(next, [{ type: 'send', kind: 'verdict', body: { request_id: card.request_id, behavior }, sid: card.sid }])
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

function onGesture(s: AppState, gesture: Gesture, map: GestureMap, now: number): Result {
  const screen = s.screen === 'sessions' ? 'menu' : s.screen
  const action = resolveGesture(map, screen, gesture)
  const v = view(s)
  switch (action) {
    case 'app.exit':
      return done(s, [{ type: 'exit' }])
    case 'live.or.exit':
      return v.fromBottom > 0 ? done(mapActive(s, x => ({ ...x, fromBottom: 0 }))) : done(s, [{ type: 'exit' }])
    case 'timeline.up':
      return done(mapActive(s, x => ({ ...x, fromBottom: Math.min(maxScroll(x.entries), x.fromBottom + SCROLL_STEP) })))
    case 'timeline.down':
      return done(mapActive(s, x => ({ ...x, fromBottom: Math.max(0, x.fromBottom - SCROLL_STEP) })))
    case 'timeline.live':
      return done(mapActive(s, x => ({ ...x, fromBottom: 0 })))
    case 'menu.open':
      return done({ ...open(s, 'menu', now), menuIndex: 0 })
    case 'voice.start':
      return done(s.voiceAvailable ? startListening(s, now) : s)
    case 'nav.back':
      return done({ ...s, screen: 'timeline' })
    case 'card.prev':
      if (s.screen === 'question') return done({ ...s, questionIndex: Math.max(0, s.questionIndex - 1) })
      if (s.screen === 'card') return done({ ...s, cardChoice: 'allow' })
      if (s.screen === 'sessions') return done({ ...s, sessionIndex: Math.max(0, s.sessionIndex - 1) })
      return done({ ...s, menuIndex: Math.max(0, s.menuIndex - 1) })
    case 'card.next':
      if (s.screen === 'question') {
        const last = (s.questions[0]?.options.length ?? 1) - 1
        return done({ ...s, questionIndex: Math.min(last, s.questionIndex + 1) })
      }
      if (s.screen === 'card') return done({ ...s, cardChoice: 'deny' })
      if (s.screen === 'sessions') return done({ ...s, sessionIndex: Math.min(sessionList(s).length - 1, s.sessionIndex + 1) })
      return done({ ...s, menuIndex: Math.min(menuItems(s).length - 1, s.menuIndex + 1) })
    case 'card.confirm':
      if (s.screen === 'question') return confirmQuestion(s, now)
      if (s.screen === 'card') return confirmCard(s, now)
      if (s.screen === 'sessions') return confirmSession(s)
      return confirmMenu(s, now)
    case 'voice.send':
    case 'voice.cancel':
      return s.screen === 'voice' ? onVoiceGesture(s, action, now) : done(s)
    default:
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
      // Without a clock (tests of non-card screens) the card guard is not applied.
      return onGesture(s, msg.gesture, msg.map, msg.now ?? Number.POSITIVE_INFINITY)
    case 'paired':
      return done({ ...s, paired: msg.paired })
    case 'config':
      return done({ ...s, voiceAvailable: msg.voiceAvailable })
    case 'transcript':
      if (msg.attempt !== s.voice.attempt || s.voice.phase !== 'transcribing') return done(s)
      return onTranscript(s, msg.text, msg.now)
    case 'partial':
      if (msg.attempt !== s.voice.attempt || s.voice.phase !== 'listening') return done(s)
      return done({ ...s, voice: { ...s.voice, partial: msg.text } })
    case 'transcript_error':
      if (msg.attempt !== s.voice.attempt || s.voice.phase !== 'transcribing') return done(s)
      return done(voiceError(s, msg.message))
    case 'voice_limit':
      return done(s.voice.phase === 'listening' ? { ...s, voice: { ...s.voice, phase: 'transcribing' } } : s)
    case 'tick':
      return done({ ...s, clock: msg.now })
  }
}
