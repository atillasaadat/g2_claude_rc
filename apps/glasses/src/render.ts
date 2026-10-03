// Pure rendering: AppState -> the text of the two containers. Every line is
// measured with pretext so nothing ever wraps or overflows on the glasses.

import { BODY_LINES, fitLine } from './layout'
import { FEED_LINES, type AppState, type FeedLine, type Link } from './state'

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
  if (!s.session) return fitLine(`${DOT[s.link]} waiting for Claude Code`)
  const { name, state, mode } = s.session
  return fitLine(`${DOT[s.link]} ${name} · ${state}${mode ? ` · ${mode}` : ''}`)
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
  if (s.glance) lines.push('', fitLine(`— ${s.glance}`))
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

export function render(s: AppState): Frame {
  if (!s.paired) return { header: header(s), body: unpairedBody() }
  if (s.screen === 'reply' && s.reply) return { header: header(s), body: s.reply.pages[s.replyPage] ?? '' }
  return { header: header(s), body: feedBody(s) }
}
