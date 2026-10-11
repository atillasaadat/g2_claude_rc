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
import { OVERLAY_WIDTH, TIMELINE_LINES, wrapLines } from './layout'
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
export const TOAST_MS = 8_000

export type Link = 'offline' | 'relay' | 'online'
export type ScreenId = 'timeline' | 'menu' | 'card' | 'question' | 'voice'

export interface MenuItem {
  id: 'review' | 'review_question' | 'talk' | 'stop' | 'dark' | 'end' | 'end_cancel' | 'end_confirm'
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
  /** First transcript line shown while reviewing (swipes scroll it). */
  scroll?: number
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
  /** The relay connection during which this session last sent something live. */
  liveEpoch: number
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
  /**
   * Counts relay connections. On every connect each live channel re-announces
   * itself (resync), so a session is alive if it spoke during this connection;
   * sessions only seen in replayed history are dead and stay hidden.
   */
  connectEpoch: number
  active: string
  screen: ScreenId
  /** Animation clock (ms), advanced by ticks while something animates. */
  clock: number
  overlaySince: number
  menuIndex: number
  /** The menu is asking whether to unpair (End session). */
  confirmEnd: boolean
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
  /**
   * Display sleep while Claude works, in ms (0: always on). See shouldSleep.
   * `dark` means the app draws nothing; the next gesture only wakes it.
   */
  displaySleepMs: number
  dark: boolean
  /** Last gesture or wake: the sleep timer counts from here. */
  awakeSince: number
  toast?: { text: string; until: number }
}

export type Msg =
  | { type: 'envelope'; env: AnyEnvelope; now: number }
  | { type: 'relay'; status: 'connecting' | 'open' | 'closed' }
  | { type: 'presence'; computers: number }
  | { type: 'gesture'; gesture: Gesture; map: GestureMap; now?: number }
  | { type: 'paired'; paired: boolean }
  | { type: 'config'; voiceAvailable?: boolean; displaySleepMs?: number }
  | { type: 'transcript'; attempt: number; text: string; now: number }
  | { type: 'partial'; attempt: number; text: string }
  | { type: 'transcript_error'; attempt: number; message: string }
  | { type: 'voice_limit' }
  | { type: 'tick'; now: number }
  /** An item of the glasses OS side menu was chosen (see osMenu). */
  | { type: 'os_menu'; itemID: number }

/** Commands name their target session (sid), since several share the relay room. */
export type Effect =
  | { type: 'exit' }
  /** Forget the pairing on this phone: every session goes, and /g2:pair reconnects. */
  | { type: 'unpair' }
  | { type: 'send'; kind: 'stop'; body: Record<string, never>; sid: string }
  | { type: 'send'; kind: 'verdict'; body: Body<'verdict'>; sid: string }
  | { type: 'send'; kind: 'prompt'; body: Body<'prompt'>; sid: string }
  | { type: 'send'; kind: 'answer'; body: Body<'answer'>; sid: string }

export interface Result {
  state: AppState
  effects: Effect[]
}

const EMPTY_VIEW: SessionView = { sessionTs: 0, entries: [], fromBottom: 0, stopPending: false, lastSeen: 0, unread: false, liveEpoch: -1 }

export function initialState(): AppState {
  return {
    paired: false,
    relayOpen: false,
    computers: 0,
    link: 'offline',
    views: {},
    connectEpoch: 0,
    active: '',
    screen: 'timeline',
    clock: 0,
    overlaySince: 0,
    menuIndex: 0,
    confirmEnd: false,
    cards: [],
    cardChoice: 'deny',
    cardShownAt: 0,
    questions: [],
    questionIndex: 0,
    questionShownAt: 0,
    voice: { phase: 'idle', attempt: 0 },
    voiceAvailable: false,
    displaySleepMs: 0,
    dark: false,
    awakeSince: 0,
  }
}

// Views ------------------------------------------------------------------

export const view = (s: AppState, sid: string = s.active): SessionView => s.views[sid] ?? EMPTY_VIEW
const withView = (s: AppState, sid: string, v: SessionView): AppState => ({ ...s, views: { ...s.views, [sid]: v } })
const mapActive = (s: AppState, f: (v: SessionView) => SessionView): AppState => withView(s, s.active, f(view(s)))

const alive = (s: AppState, sid: string): boolean => view(s, sid).liveEpoch === s.connectEpoch

/**
 * Live sessions (and the one on screen), in a stable order (name, then id):
 * the OS side menu is rebuilt whenever this list changes, so it must not reshuffle.
 */
export function sessionList(s: AppState): Array<{ sid: string; view: SessionView }> {
  return Object.entries(s.views)
    .filter(([sid, v]) => (v.session || v.entries.length > 0) && (alive(s, sid) || sid === s.active))
    .map(([sid, v]) => ({ sid, view: v }))
    .sort((a, b) => (a.view.session?.name ?? '').localeCompare(b.view.session?.name ?? '') || a.sid.localeCompare(b.sid))
}

export interface OsMenuItem {
  id: number
  label: string
  sid?: string
  clear?: true
}

/** The OS menu takes UTF-8 labels of at most 32 bytes. */
function byteClip(text: string, max = 32): string {
  const enc = new TextEncoder()
  if (enc.encode(text).length <= max) return text
  let out = ''
  for (const ch of text) {
    if (enc.encode(`${out}${ch}…`).length > max) break
    out += ch
  }
  return `${out}…`
}

export const CLEAR_ITEM_ID = 99

/**
 * The glasses OS side menu: with two or more sessions, one item per session
 * (switch to it) plus Clear. The OS adds its own items (Close, Display off,
 * brightness) after these, so the app adds no exit of its own.
 * Labels avoid live state so the menu (a page rebuild) changes rarely.
 */
export function osMenu(s: AppState): OsMenuItem[] {
  const list = s.paired ? sessionList(s).slice(0, 9) : []
  if (list.length < 2) return []
  return [
    ...list.map(({ sid, view: v }, i) => ({
      id: i + 1,
      label: byteClip(`${sid === s.active ? '▶ ' : ''}${v.session?.name ?? 'Claude Code'}`),
      sid,
    })),
    { id: CLEAR_ITEM_ID, label: 'Clear other sessions', clear: true as const },
  ]
}

export const sessionName = (s: AppState, sid: string): string => view(s, sid).session?.name ?? 'Claude Code'

export function menuItems(s: AppState): MenuItem[] {
  // End session asks first, on Cancel, so one stray tap never unpairs the phone.
  if (s.confirmEnd) {
    return [
      { id: 'end_cancel', label: 'Cancel', available: true },
      { id: 'end_confirm', label: 'Unpair phone', available: true },
    ]
  }
  return [
    ...(s.cards[0] ? [{ id: 'review' as const, label: `Review: ${s.cards[0].tool_name}`, available: true }] : []),
    ...(s.questions[0] ? [{ id: 'review_question' as const, label: 'Review question', available: true }] : []),
    { id: 'talk', label: s.voiceAvailable ? 'Talk' : 'Talk (no Groq key)', available: s.voiceAvailable },
    { id: 'stop', label: 'Stop Claude', available: true },
    { id: 'dark', label: 'Display off', available: true },
    { id: 'end', label: 'End session', available: true },
  ]
}

/** The mic is on exactly while the voice overlay is listening; main syncs the bridge to this. */
export function micWanted(s: AppState): boolean {
  return s.screen === 'voice' && s.voice.phase === 'listening'
}

/** Whether the animation clock needs to tick (dots, pulse, fade, toast). */
export function isAnimating(s: AppState): boolean {
  const v = view(s)
  // Dark draws nothing, and every way out of it is an event, not the clock.
  if (s.dark) return false
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
  const seen = { ...v, lastSeen: Math.max(v.lastSeen, env.ts), liveEpoch: fresh ? s.connectEpoch : v.liveEpoch }
  // The first session seen goes on screen; a live one replaces a dead one from history.
  const takeOver = (s.active === '' && !s.views['']) || (fresh && env.kind === 'session' && sid !== s.active && !alive(s, s.active))
  const base = takeOver ? { ...s, active: sid } : s
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
      // Permission prompts are what need the user (questions and cards pop up on their own).
      const needsInput = env.body.type === 'notify' && /needs your permission/i.test(env.body.summary)
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
    case 'question_resolved':
      return dropQuestion(s, env.body.question_id, now)
    default:
      return onSessionEnvelope(s, sid, env, now)
  }
}

// Display sleep -------------------------------------------------------------

/** Transcript lines the review box shows at once, and how far a swipe moves. */
export const VOICE_REVIEW_LINES = 5
const VOICE_SCROLL_STEP = 3
export const voiceLineCount = (text: string): number => wrapLines(text, OVERLAY_WIDTH).length

/**
 * With display sleep on, the display goes dark once the session on screen has
 * been working for displaySleepMs with no gesture, and nothing needs the user
 * (no card, question, menu or voice box).
 */
export function shouldSleep(s: AppState, now: number): boolean {
  return (
    s.displaySleepMs > 0 &&
    !s.dark &&
    s.paired &&
    view(s).session?.state === 'working' &&
    s.screen === 'timeline' &&
    s.cards.length === 0 &&
    s.questions.length === 0 &&
    now - s.awakeSince >= s.displaySleepMs
  )
}

const wake = (s: AppState, now: number): AppState => ({ ...s, dark: false, awakeSince: now })

/**
 * After an envelope: a new turn starts the sleep timer, and anything that is
 * a response or needs the user wakes the display (it then stays on until the
 * user turns it off or a new turn starts). History replays never wake it.
 */
function afterEnvelope(prev: AppState, next: AppState, env: AnyEnvelope, now: number): AppState {
  if (now - env.ts > FRESH_MS) return next
  const sid = env.sid ?? ''
  const onScreen = sid === next.active
  if (env.kind === 'session' && onScreen && env.body.state === 'working' && view(prev, sid).session?.state !== 'working') {
    return { ...next, awakeSince: now }
  }
  if (!next.dark) return next
  const response =
    env.kind === 'permission' ||
    env.kind === 'question' ||
    (env.kind === 'reply' && onScreen) ||
    (env.kind === 'session' && onScreen && env.body.state !== 'working') ||
    (next.toast !== undefined && next.toast !== prev.toast)
  return response ? wake(next, now) : next
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

/** Answered in the terminal (or withdrawn): the card goes, and the next question or the timeline shows. */
function dropQuestion(s: AppState, questionId: string, now: number): AppState {
  const wasShown = s.screen === 'question' && s.questions[0]?.question_id === questionId
  const questions = s.questions.filter(q => q.question_id !== questionId)
  if (questions.length === s.questions.length) return s
  const next = { ...s, questions }
  if (!wasShown) return next
  return questions.length ? showQuestion(next, now, 0) : { ...next, screen: 'timeline' }
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
    case 'dark':
      return done({ ...s, screen: 'timeline', dark: true })
    case 'end':
      return done({ ...s, confirmEnd: true, menuIndex: 0 })
    case 'end_cancel':
      return done({ ...s, confirmEnd: false, screen: 'timeline' })
    case 'end_confirm':
      return done({ ...s, confirmEnd: false, screen: 'timeline' }, [{ type: 'unpair' }])
    default:
      return done(s)
  }
}

/** An OS side-menu choice: switch to a session, or clear the others. */
function onOsMenu(s: AppState, itemID: number): Result {
  const item = osMenu(s).find(i => i.id === itemID)
  if (!item) return done(s)
  if (item.clear) return done({ ...s, views: { [s.active]: view(s) }, toast: undefined })
  const sid = item.sid!
  // Overlays stay (a pending card or question still needs an answer).
  return done(withView({ ...s, active: sid, toast: undefined }, sid, { ...view(s, sid), unread: false }))
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
  const action = resolveGesture(map, s.screen, gesture)
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
      return done({ ...open(s, 'menu', now), menuIndex: 0, confirmEnd: false })
    case 'voice.start':
      return done(s.voiceAvailable ? startListening(s, now) : s)
    case 'nav.back':
      return done({ ...s, screen: 'timeline' })
    case 'card.prev':
      if (s.screen === 'question') return done({ ...s, questionIndex: Math.max(0, s.questionIndex - 1) })
      if (s.screen === 'card') return done({ ...s, cardChoice: 'allow' })
      return done({ ...s, menuIndex: Math.max(0, s.menuIndex - 1) })
    case 'card.next':
      if (s.screen === 'question') {
        const last = (s.questions[0]?.options.length ?? 1) - 1
        return done({ ...s, questionIndex: Math.min(last, s.questionIndex + 1) })
      }
      if (s.screen === 'card') return done({ ...s, cardChoice: 'deny' })
      return done({ ...s, menuIndex: Math.min(menuItems(s).length - 1, s.menuIndex + 1) })
    case 'card.confirm':
      if (s.screen === 'question') return confirmQuestion(s, now)
      if (s.screen === 'card') return confirmCard(s, now)
      return confirmMenu(s, now)
    case 'voice.send':
    case 'voice.cancel':
      return s.screen === 'voice' ? onVoiceGesture(s, action, now) : done(s)
    case 'voice.up':
    case 'voice.down': {
      if (s.screen !== 'voice' || s.voice.phase !== 'review') return done(s)
      const step = action === 'voice.up' ? -VOICE_SCROLL_STEP : VOICE_SCROLL_STEP
      const max = Math.max(0, voiceLineCount(s.voice.text ?? '') - VOICE_REVIEW_LINES)
      return done({ ...s, voice: { ...s.voice, scroll: Math.min(max, Math.max(0, (s.voice.scroll ?? 0) + step)) } })
    }
    default:
      return done(s)
  }
}

export function reduce(s: AppState, msg: Msg): Result {
  switch (msg.type) {
    case 'envelope':
      return done(afterEnvelope(s, onEnvelope(s, msg.env, msg.now), msg.env, msg.now))
    case 'relay': {
      const relayOpen = msg.status === 'open'
      const computers = relayOpen ? s.computers : 0
      const connectEpoch = relayOpen && !s.relayOpen ? s.connectEpoch + 1 : s.connectEpoch
      return done({ ...s, relayOpen, computers, connectEpoch, link: link(relayOpen, computers) })
    }
    case 'presence': {
      // A computer left: its session may have died without saying so. Every
      // live channel re-announces on this, so the dead one drops out of the list.
      const left = s.relayOpen && msg.computers < s.computers
      const connectEpoch = left ? s.connectEpoch + 1 : s.connectEpoch
      return done({ ...s, computers: msg.computers, connectEpoch, link: link(s.relayOpen, msg.computers) })
    }
    case 'gesture': {
      const clock = msg.now ?? s.clock
      // A dark display only wakes: a blind tap must not open the menu or confirm a card.
      if (s.dark) return done(wake(s, clock))
      // Without a clock (tests of non-card screens) the card guard is not applied.
      const r = onGesture(s, msg.gesture, msg.map, msg.now ?? Number.POSITIVE_INFINITY)
      return r.state.dark ? r : { ...r, state: { ...r.state, awakeSince: clock } }
    }
    case 'paired':
      // Unpaired: every session, card and question goes with the pairing.
      return done(msg.paired ? { ...s, paired: true } : { ...initialState(), voiceAvailable: s.voiceAvailable, displaySleepMs: s.displaySleepMs, clock: s.clock })
    case 'config': {
      const next = {
        ...s,
        ...(msg.voiceAvailable !== undefined ? { voiceAvailable: msg.voiceAvailable } : {}),
        ...(msg.displaySleepMs !== undefined ? { displaySleepMs: msg.displaySleepMs } : {}),
      }
      // Turning sleep off wakes a dark display.
      return done(next.displaySleepMs === 0 && next.dark ? wake(next, s.clock) : next)
    }
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
    case 'tick': {
      const next = { ...s, clock: msg.now }
      return done(shouldSleep(next, msg.now) ? { ...next, dark: true } : next)
    }
    case 'os_menu':
      return onOsMenu(s, msg.itemID)
  }
}
