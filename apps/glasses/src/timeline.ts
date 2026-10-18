// The continuous timeline: entries (prompts, tool calls, notes, glances,
// replies) flattened into pre-wrapped display lines. Pure; the reducer uses
// the line counts for scrolling and the renderer slices the visible window.

import { getTextWidth } from '@evenrealities/pretext'
import { fitLine, TIMELINE_WIDTH, wrapBlock, wrapLines } from './layout'

const INDENT = '  '

export interface TimelineEntry {
  id: string
  ts: number
  kind: 'prompt' | 'tool' | 'notify' | 'glance' | 'reply'
  text: string
  tool?: string
  result?: string
  origin?: 'glasses' | 'local'
  /** The tool_end envelope merged into this tool line, so a replay of it is recognised. */
  endId?: string
}

export interface TimelineLines {
  lines: readonly string[]
  /** First line index of each entry, by entry id. */
  starts: ReadonlyMap<string, number>
}

function entryLines(e: TimelineEntry, width: number): string[] {
  switch (e.kind) {
    case 'prompt': {
      const suffix = e.origin === 'glasses' ? ' (voice)' : ''
      // Continuation lines are indented, so wrap narrower by the indent.
      const [first = '', ...rest] = wrapLines(`> ${e.text}${suffix}`, width - getTextWidth(INDENT))
      return [first, ...rest.map(l => `${INDENT}${l}`)]
    }
    case 'tool': {
      const label = e.tool && e.text && e.text !== e.tool ? `${e.tool}: ${e.text}` : (e.tool ?? e.text)
      return [fitLine(e.result === undefined ? `▶ ${label}` : `• ${label} → ${e.result}`, width)]
    }
    // Notes and glances are full sentences: wrapped, never cut.
    case 'notify':
      return wrapBlock(`! ${e.text.replace(/\s+/g, ' ').trim()}`, width)
    case 'glance':
      return wrapBlock(`» ${e.text.replace(/\s+/g, ' ').trim()}`, width)
    case 'reply':
      return wrapBlock(e.text, width)
  }
}

export function buildTimeline(entries: readonly TimelineEntry[], width: number = TIMELINE_WIDTH): TimelineLines {
  const lines: string[] = []
  const starts = new Map<string, number>()
  entries.forEach((e, i) => {
    // Breathing room around replies and before each new turn.
    const gap = i > 0 && (e.kind === 'reply' || e.kind === 'prompt' || entries[i - 1]!.kind === 'reply')
    if (gap) lines.push('')
    starts.set(e.id, lines.length)
    lines.push(...entryLines(e, width))
  })
  return { lines, starts }
}

/** The visible window, `fromBottom` lines up from the newest line. */
export function visibleWindow(lines: readonly string[], viewLines: number, fromBottom: number): string[] {
  const end = Math.max(0, lines.length - fromBottom)
  return lines.slice(Math.max(0, end - viewLines), end)
}
