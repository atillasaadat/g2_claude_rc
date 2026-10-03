// Pure rendering: AppState -> the text of the two containers. Every line is
// measured with pretext so nothing ever wraps or overflows on the glasses.

import { getTextWidth } from '@evenrealities/pretext'
import { BODY_LINES, INNER_WIDTH, fitLine, wrapLines } from './layout'
import { FEED_LINES, menuItems, type AppState, type FeedLine, type Link, type PermissionCard, type QuestionCard } from './state'

export interface Frame {
  header: string
  body: string
}

// Glyphs verified present in the firmware font (docs/decisions.md).
const DOT: Record<Link, string> = { online: '●', relay: '○', offline: '×' }

function header(s: AppState): string {
  if (!s.paired) return fitLine('G2 Claude Code · not paired')
  if (s.screen === 'reply' && s.reply) {
    return fitLine(`Reply ${s.replyPage + 1}/${s.reply.pages.length} · ↑↓ pages${s.session ? ` · ${s.session.name}` : ''}`)
  }
  if (s.screen === 'menu') return fitLine(`Menu${s.session ? ` · ${s.session.name}` : ''}`)
  if (s.screen === 'voice') return VOICE_HEADER[s.voice.phase]
  if (s.screen === 'question') return fitLine(`Question${s.questions.length > 1 ? ` · 1/${s.questions.length}` : ''}`)
  if (s.screen === 'card' && s.cards[0]) {
    return fitLine(`Allow ${s.cards[0].tool_name}?${s.cards.length > 1 ? ` · 1/${s.cards.length}` : ''}`)
  }
  if (!s.session) return fitLine(`${DOT[s.link]} waiting for Claude Code`)
  const { name, state, mode } = s.session
  const status = s.stopPending ? '■ stopping…' : `${state}${mode ? ` · ${mode}` : ''}`
  return fitLine(`${DOT[s.link]} ${name} · ${status}`)
}

function eventLine(e: FeedLine): string {
  switch (e.type) {
    case 'prompt':
      return fitLine(`> ${e.summary}`)
    case 'notify':
      return fitLine(`! ${e.summary}`)
    case 'tool': {
      const label = e.tool && e.summary && e.summary !== e.tool ? `${e.tool}: ${e.summary}` : (e.tool ?? e.summary)
      return fitLine(e.result === undefined ? `▶ ${label}` : `• ${label} → ${e.result}`)
    }
  }
}

function feedBody(s: AppState): string {
  const end = s.events.length - s.feedOffset
  const visible = s.events.slice(Math.max(0, end - FEED_LINES), end)
  const lines = visible.length ? visible.map(eventLine) : ['No activity yet.']
  if (s.feedOffset > 0) lines.push(fitLine(`↑↓ ${s.feedOffset} newer`))
  if (s.glance) lines.push('', fitLine(`» ${s.glance}`))
  if (s.reply && s.feedOffset === 0) {
    const n = s.reply.pages.length
    lines.push(fitLine(`↓ reply (${n} page${n === 1 ? '' : 's'})`))
  }
  return lines.slice(0, BODY_LINES).join('\n')
}

function unpairedBody(): string {
  return [
    'Not paired.',
    '',
    'On your computer run: bun channel/pair.ts',
    'then paste the pairing text into this app',
    'on your phone.',
  ]
    .map(l => fitLine(l))
    .join('\n')
}

function menuBody(s: AppState): string {
  const items = menuItems(s).map((item, i) => {
    const label = item.label
    // fitLine trims, so the indent goes outside it and the label gets the remaining width.
    return indent(i === s.menuIndex, label)
  })
  return [...items, '', fitLine('tap: select · double tap: back')].join('\n')
}

const VOICE_HEADER: Record<AppState['voice']['phase'], string> = {
  idle: 'Voice',
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  review: 'Send to Claude?',
  error: 'Voice',
}
const REVIEW_LINES = 6

function voiceBody(s: AppState): string {
  switch (s.voice.phase) {
    case 'listening':
      return ['Speak now. Say "stop" to stop Claude.', '', 'tap: done · double tap: cancel'].map(l => fitLine(l)).join('\n')
    case 'transcribing':
      return ['One moment.', '', 'double tap: cancel'].map(l => fitLine(l)).join('\n')
    case 'review': {
      const lines = wrapLines(s.voice.text ?? '')
      const shown =
        lines.length <= REVIEW_LINES
          ? lines
          : [...lines.slice(0, REVIEW_LINES - 1), fitLine(`${lines[REVIEW_LINES - 1]} ${lines[REVIEW_LINES]}`)]
      return [...shown, '', fitLine('tap: send · double tap: cancel')].join('\n')
    }
    default:
      return [s.voice.error ?? '', '', 'tap: try again · double tap: cancel'].map(l => fitLine(l)).join('\n')
  }
}

/** Body budget: question lines, a blank, then up to 4 options. */
const QUESTION_LINES = BODY_LINES - 1 - 4

function questionBody(s: AppState, q: QuestionCard): string {
  const lines = wrapLines(q.question)
  const shown =
    lines.length <= QUESTION_LINES
      ? lines
      : [...lines.slice(0, QUESTION_LINES - 1), fitLine(`${lines[QUESTION_LINES - 1]} ${lines[QUESTION_LINES]}`)]
  return [...shown, '', ...q.options.map((o, i) => indent(i === s.questionIndex, o))].join('\n')
}

const PREVIEW_LINES = 4
const indent = (selected: boolean, label: string): string => {
  const prefix = selected ? '▶ ' : '   '
  return prefix + fitLine(label, INNER_WIDTH - getTextWidth(prefix))
}

/** The preview is JSON text from Claude Code. Show its fields, minus a repeat of the description. */
function previewLines(card: PermissionCard): string[] {
  let text = card.input_preview
  try {
    const obj = JSON.parse(card.input_preview) as unknown
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      text = Object.entries(obj as Record<string, unknown>)
        .filter(([k, v]) => !(k === 'description' && v === card.description))
        .map(([k, v]) => (k === 'command' ? String(v) : `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`))
        .join('\n')
    }
  } catch {
    // Not JSON (or truncated by Claude Code): show it as is.
  }
  const lines = wrapLines(text)
  if (lines.length <= PREVIEW_LINES) return lines
  // Joining the next line forces pxTruncate to cut the last kept line with '...'.
  const kept = lines.slice(0, PREVIEW_LINES - 1)
  return [...kept, fitLine(`${lines[PREVIEW_LINES - 1]} ${lines[PREVIEW_LINES]}`)]
}

function cardBody(s: AppState, card: PermissionCard): string {
  return [
    fitLine(card.description || card.tool_name),
    '',
    ...previewLines(card),
    '',
    indent(s.cardChoice === 'allow', 'Allow'),
    indent(s.cardChoice === 'deny', 'Deny'),
  ].join('\n')
}

export function render(s: AppState): Frame {
  if (!s.paired) return { header: header(s), body: unpairedBody() }
  if (s.screen === 'card' && s.cards[0]) return { header: header(s), body: cardBody(s, s.cards[0]) }
  if (s.screen === 'menu') return { header: header(s), body: menuBody(s) }
  if (s.screen === 'voice') return { header: header(s), body: voiceBody(s) }
  if (s.screen === 'question' && s.questions[0]) return { header: header(s), body: questionBody(s, s.questions[0]) }
  if (s.screen === 'reply' && s.reply) return { header: header(s), body: s.reply.pages[s.replyPage] ?? '' }
  return { header: header(s), body: feedBody(s) }
}
