// Pure rendering: AppState -> Scene (the containers to draw). Every line is
// measured with pretext so nothing ever wraps or overflows on the glasses.
//
// Brightness (textColor 0..4) is per container and can change without a
// rebuild, which is what the animations use: the timeline dims behind an
// overlay, overlays fade in, the mic label pulses, the working dots move.

import { getTextWidth } from '@evenrealities/pretext'
import {
  clampLines,
  fitLine,
  LINE_H,
  HEADER,
  HEADER_WIDTH,
  innerWidth,
  OVERLAY_WIDTH,
  overlayBox,
  sideBox,
  spread,
  tailLines,
  TIMELINE,
  TIMELINE_LINES,
  type Box,
} from './layout'
import { FADE_MS, menuItems, sessionList, sessionName, view, type AppState, type Link, type PermissionCard, type QuestionCard } from './state'
import { buildTimeline, visibleWindow } from './timeline'

export interface ContainerSpec {
  id: number
  name: string
  box: Box
  content: string
  /** Text brightness 0..4. */
  brightness: number
  capture: boolean
  /** Stacking order, larger in front. */
  z: number
}

export interface Scene {
  containers: readonly ContainerSpec[]
}

/** A flat view of a scene, for logs, the phone mirror, and tests. */
export interface Frame {
  header: string
  timeline: string
  overlay?: { name: string; content: string }
}

export const HEADER_ID = 1
export const TIMELINE_ID = 2
export const OVERLAY_ID = 3

const BRIGHT = 4
const DIM = 1

// Glyphs verified present in the firmware font (docs/decisions.md).
const DOT: Record<Link, string> = { online: '●', relay: '○', offline: '×' }

const indent = (selected: boolean, label: string, width: number): string => {
  const prefix = selected ? '▶ ' : '   '
  return prefix + fitLine(label, width - getTextWidth(prefix))
}

/** Working dots cycle 1..3 while Claude works. */
const dots = (clock: number): string => '·'.repeat(1 + (Math.floor(clock / 400) % 3))

function statusHeader(s: AppState): string {
  if (!s.paired) return fitLine('G2 Claude Code · not paired', HEADER_WIDTH)
  // A toast about another session takes the header for a few seconds.
  if (s.toast && s.clock < s.toast.until) return fitLine(s.toast.text, HEADER_WIDTH)
  const v = view(s)
  if (!v.session) return spread(`${DOT[s.link]} waiting for Claude Code`, '', HEADER_WIDTH)
  const { name, state, mode } = v.session
  const status = v.stopPending ? '■ stopping…' : state === 'working' ? `working ${dots(s.clock)}` : state
  const unread = sessionList(s).some(x => x.sid !== s.active && x.view.unread) ? '◆ ' : ''
  const right = `${unread}${v.fromBottom > 0 ? `▼ ${v.fromBottom} newer` : (mode ?? '')}`
  return spread(`${DOT[s.link]} ${name} · ${status}`, right, HEADER_WIDTH)
}

const HINTS: Record<Exclude<AppState['screen'], 'timeline'>, string> = {
  menu: '↑↓ choose · tap: select · 2× tap: back',
  sessions: '↑↓ choose · tap: switch · 2× tap: back',
  card: '↑ allow · ↓ deny · tap: confirm · 2× tap: later',
  question: '↑↓ choose · tap: answer · 2× tap: later',
  voice: '',
}

function voiceHint(s: AppState): string {
  switch (s.voice.phase) {
    case 'listening':
      return 'tap: done · 2× tap: cancel'
    case 'review':
      return 'tap: send · 2× tap: cancel'
    case 'error':
      return 'tap: try again · 2× tap: cancel'
    default:
      return '2× tap: cancel'
  }
}

function header(s: AppState): string {
  if (s.screen === 'timeline' || !s.paired) return statusHeader(s)
  return fitLine(s.screen === 'voice' ? voiceHint(s) : HINTS[s.screen], HEADER_WIDTH)
}

function timelineText(s: AppState): string {
  const w = innerWidth(TIMELINE)
  if (!s.paired) {
    return ['Not paired.', '', 'On your computer run: bun channel/pair.ts', 'then paste the pairing text into this app', 'on your phone.']
      .map(l => fitLine(l, w))
      .join('\n')
  }
  const v = view(s)
  const { lines } = buildTimeline(v.entries)
  if (!lines.length) return fitLine('No activity yet. Tap for the menu.', w)
  return visibleWindow(lines, TIMELINE_LINES, v.fromBottom).join('\n')
}

// Overlays ---------------------------------------------------------------

function menuOverlay(s: AppState): { box: Box; content: string } {
  const items = menuItems(s)
  const box = sideBox(items.length)
  return { box, content: items.map((item, i) => indent(i === s.menuIndex, item.label, innerWidth(box))).join('\n') }
}

const STATE_GLYPH: Record<string, string> = { working: '▶', waiting: '!', idle: '·', stopped: '■' }

function sessionsOverlay(s: AppState): { box: Box; content: string } {
  const list = sessionList(s)
  const box = overlayBox(list.length)
  const w = innerWidth(box)
  const lines = list.map(({ sid, view: v }, i) => {
    const st = v.session?.state ?? 'idle'
    const label = `${STATE_GLYPH[st] ?? '·'} ${v.session?.name ?? sid} · ${st}${sid === s.active ? ' (on screen)' : ''}${v.unread ? '  ◆' : ''}`
    return indent(i === s.sessionIndex, label, w)
  })
  return { box, content: lines.join('\n') }
}

/** With several sessions, cards say which one is asking. */
const fromSession = (s: AppState, sid: string): string => (sessionList(s).length > 1 ? ` · ${sessionName(s, sid)}` : '')

/** The preview is JSON text from Claude Code. Show its fields, minus a repeat of the description. */
function previewText(card: PermissionCard): string {
  try {
    const obj = JSON.parse(card.input_preview) as unknown
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return Object.entries(obj as Record<string, unknown>)
        .filter(([k, v]) => !(k === 'description' && v === card.description))
        .map(([k, v]) => (k === 'command' ? String(v) : `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`))
        .join('\n')
    }
  } catch {
    // Not JSON (or truncated by Claude Code): show it as is.
  }
  return card.input_preview
}

function cardOverlay(s: AppState, card: PermissionCard): { box: Box; content: string } {
  const w = OVERLAY_WIDTH
  const title = `Allow ${card.tool_name}?${fromSession(s, card.sid)}${s.cards.length > 1 ? `  (1 of ${s.cards.length})` : ''}`
  // Short fixed labels, so no fitting: fitLine would collapse the spacing.
  const mark = (on: boolean) => (on ? '▶ ' : '   ')
  const choices = `${mark(s.cardChoice === 'allow')}Allow${' '.repeat(12)}${mark(s.cardChoice === 'deny')}Deny`
  const lines = [
    fitLine(title, w),
    fitLine(card.description || card.tool_name, w),
    '',
    ...clampLines(previewText(card), 3, w),
    '',
    choices,
  ]
  return { box: overlayBox(lines.length), content: lines.join('\n') }
}

function questionOverlay(s: AppState, q: QuestionCard): { box: Box; content: string } {
  const w = OVERLAY_WIDTH
  const count = s.questions.length > 1 ? `(1 of ${s.questions.length}) ` : ''
  const who = sessionList(s).length > 1 ? `${sessionName(s, q.sid)} asks: ` : ''
  const lines = [...clampLines(`${count}${who}${q.question}`, 3, w), '', ...q.options.map((o, i) => indent(i === s.questionIndex, o, w))]
  return { box: overlayBox(lines.length), content: lines.join('\n') }
}

/** Live while listening (fixed 3-line box, so it never rebuilds as text grows); sized to fit on review. */
function voiceOverlay(s: AppState): { box: Box; content: string } {
  const w = OVERLAY_WIDTH
  const v = s.voice
  switch (v.phase) {
    case 'listening': {
      const pulse = Math.floor(s.clock / 500) % 2 ? '○' : '●'
      const said = v.partial ? tailLines(`${v.partial} _`, 2, w) : ['Speak now. Say "stop" to stop Claude.']
      const lines = [`${pulse} Listening`, ...said, ...(said.length < 2 ? [''] : [])]
      return { box: overlayBox(3), content: lines.map(l => fitLine(l, w)).join('\n') }
    }
    case 'transcribing': {
      const said = v.partial ? tailLines(v.partial, 2, w) : ['One moment.', '']
      return { box: overlayBox(3), content: ['○ Transcribing', ...said].map(l => fitLine(l, w)).join('\n') }
    }
    case 'review': {
      const lines = ['Send to Claude?', ...clampLines(v.text ?? '', 5, w)]
      return { box: overlayBox(lines.length), content: lines.join('\n') }
    }
    default:
      return { box: overlayBox(2), content: ['Voice', fitLine(v.error ?? '', w)].join('\n') }
  }
}

function overlay(s: AppState): { name: string; box: Box; content: string } | null {
  switch (s.screen) {
    case 'menu':
      return { name: 'menu', ...menuOverlay(s) }
    case 'sessions':
      return { name: 'sessions', ...sessionsOverlay(s) }
    case 'card':
      return s.cards[0] ? { name: 'card', ...cardOverlay(s, s.cards[0]) } : null
    case 'question':
      return s.questions[0] ? { name: 'question', ...questionOverlay(s, s.questions[0]) } : null
    case 'voice':
      return { name: 'voice', ...voiceOverlay(s) }
    default:
      return null
  }
}

/** Overlays fade in: brightness 2, 3, then 4 over FADE_MS. */
function fade(s: AppState): number {
  const t = s.clock - s.overlaySince
  if (!Number.isFinite(t) || t >= FADE_MS) return BRIGHT
  return t < FADE_MS / 3 ? 2 : 3
}

/**
 * The display has no fill: unpainted pixels are off, so an overlay cannot hide
 * what is under it. Occlude instead: blank the timeline rows a full-width box
 * covers, and clip rows short of a side box, so the box reads as solid.
 */
export function occlude(timeline: string, box: Box): string {
  const top = TIMELINE.y + TIMELINE.border + TIMELINE.padding
  const left = TIMELINE.x + TIMELINE.border + TIMELINE.padding
  const clipTo = box.x - left - 12
  return timeline
    .split('\n')
    .map((line, i) => {
      const y0 = top + i * LINE_H
      const covered = y0 < box.y + box.h && y0 + LINE_H > box.y
      if (!covered) return line
      return clipTo < 40 ? '' : fitLine(line, clipTo)
    })
    .join('\n')
}

export function render(s: AppState): Scene {
  const over = s.paired ? overlay(s) : null
  const timeline = over ? occlude(timelineText(s), over.box) : timelineText(s)
  return {
    containers: [
      { id: HEADER_ID, name: 'header', box: HEADER, content: header(s), brightness: 3, capture: false, z: 1 },
      // The timeline always captures input: taps arrive as sysEvent, swipes as textEvent.
      { id: TIMELINE_ID, name: 'timeline', box: TIMELINE, content: timeline, brightness: over ? DIM : BRIGHT, capture: true, z: 2 },
      ...(over ? [{ id: OVERLAY_ID, name: over.name, box: over.box, content: over.content, brightness: fade(s), capture: false, z: 3 }] : []),
    ],
  }
}

export function frameOf(scene: Scene): Frame {
  const by = (id: number) => scene.containers.find(c => c.id === id)
  const o = by(OVERLAY_ID)
  return {
    header: by(HEADER_ID)?.content ?? '',
    timeline: by(TIMELINE_ID)?.content ?? '',
    ...(o ? { overlay: { name: o.name, content: o.content } } : {}),
  }
}
