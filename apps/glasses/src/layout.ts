// Display geometry and pixel-accurate text fitting via @evenrealities/pretext,
// which measures with the same glyph widths LVGL uses on the G2.
//
// Every screen uses the same two text containers, so switching screens is a
// flicker-free textContainerUpgrade, never a page rebuild.

import { getTextWidth, pxTruncate } from '@evenrealities/pretext'

export const SCREEN_W = 576
export const SCREEN_H = 288
export const LINE_H = 27
export const PADDING = 4

export const HEADER = { x: 0, y: 0, w: SCREEN_W, h: LINE_H + 2 * PADDING } as const
export const BODY = { x: 0, y: HEADER.h, w: SCREEN_W, h: SCREEN_H - HEADER.h } as const

/** Text budget per line: the inner width minus a small safety margin against LVGL rounding. */
export const INNER_WIDTH = SCREEN_W - 2 * PADDING - 8
export const BODY_LINES = Math.floor((BODY.h - 2 * PADDING) / LINE_H)

const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** One line, truncated with '...' to fit. */
export function fitLine(text: string, maxPx: number = INNER_WIDTH): string {
  return pxTruncate(flatten(text), maxPx)
}

function hardBreak(word: string, maxPx: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of word) {
    if (cur && getTextWidth(cur + ch) > maxPx) {
      out.push(cur)
      cur = ch
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

/** Greedy word wrap into lines that each fit maxPx. Explicit newlines are kept. */
export function wrapLines(text: string, maxPx: number = INNER_WIDTH): string[] {
  const lines: string[] = []
  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    const words = paragraph.split(/[ \t]+/).filter(Boolean)
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let cur = ''
    for (const word of words) {
      const candidate = cur ? `${cur} ${word}` : word
      if (getTextWidth(candidate) <= maxPx) {
        cur = candidate
        continue
      }
      if (cur) lines.push(cur)
      if (getTextWidth(word) <= maxPx) {
        cur = word
      } else {
        const pieces = hardBreak(word, maxPx)
        cur = pieces.pop() ?? ''
        lines.push(...pieces)
      }
    }
    lines.push(cur)
  }
  return lines
}

/** Splits text into body-sized pages of pre-wrapped lines. */
export function paginate(text: string, linesPerPage: number = BODY_LINES): string[] {
  const lines = wrapLines(text)
  const pages: string[] = []
  for (let i = 0; i < lines.length; i += linesPerPage) pages.push(lines.slice(i, i + linesPerPage).join('\n'))
  return pages.length ? pages : ['']
}
