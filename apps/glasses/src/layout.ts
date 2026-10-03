// Display geometry and pixel-accurate text fitting via @evenrealities/pretext,
// which measures with the same glyph widths LVGL uses on the G2.
//
// Scene layout (576x288): a header pill, a continuous timeline, and at most
// one overlay box (voice, permission card, question, menu) drawn above a
// dimmed timeline. Insets are padding + border on every side (font skill).

import { getTextWidth, pxTruncate } from '@evenrealities/pretext'

export const SCREEN_W = 576
export const SCREEN_H = 288
export const LINE_H = 27
/** Kept clear of every container's inner width against LVGL rounding. */
const SAFETY = 8

export interface Box {
  x: number
  y: number
  w: number
  h: number
  border: number
  radius: number
  padding: number
}

export const innerWidth = (b: Box): number => b.w - 2 * (b.padding + b.border) - SAFETY
export const innerLines = (b: Box): number => Math.floor((b.h - 2 * (b.padding + b.border)) / LINE_H)
/** Height of a box that holds exactly `lines` lines. */
export const heightFor = (lines: number, border: number, padding: number): number => lines * LINE_H + 2 * (border + padding)

export const HEADER: Box = { x: 0, y: 0, w: SCREEN_W, h: 34, border: 1, radius: 8, padding: 2 }
export const TIMELINE: Box = { x: 0, y: 38, w: SCREEN_W, h: SCREEN_H - 38, border: 0, radius: 0, padding: 2 }
export const TIMELINE_LINES = innerLines(TIMELINE)

const OVERLAY_BORDER = 2
const OVERLAY_PAD = 6

/** Full-width overlay (voice, cards) `lines` tall, starting just under the header. */
export function overlayBox(lines: number): Box {
  return { x: 12, y: 42, w: SCREEN_W - 24, h: heightFor(lines, OVERLAY_BORDER, OVERLAY_PAD), border: OVERLAY_BORDER, radius: 10, padding: OVERLAY_PAD }
}

/** Compact overlay on the right (menu). */
export function sideBox(lines: number): Box {
  const w = 240
  return { x: SCREEN_W - w - 12, y: 42, w, h: heightFor(lines, OVERLAY_BORDER, OVERLAY_PAD), border: OVERLAY_BORDER, radius: 10, padding: OVERLAY_PAD }
}

/** Widest overlay, used to wrap overlay text before the box is sized. */
export const OVERLAY_WIDTH = innerWidth(overlayBox(1))
export const HEADER_WIDTH = innerWidth(HEADER)
export const TIMELINE_WIDTH = innerWidth(TIMELINE)
/** Back-compat name for the widest single-line budget. */
export const INNER_WIDTH = TIMELINE_WIDTH

const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** One line, truncated with '...' to fit. */
export function fitLine(text: string, maxPx: number = INNER_WIDTH): string {
  return pxTruncate(flatten(text), maxPx)
}

/** Left and right text on one line, the right part pushed to the edge with spaces. */
export function spread(left: string, right: string, maxPx: number): string {
  if (!right) return fitLine(left, maxPx)
  const r = fitLine(right, Math.floor(maxPx / 2))
  const l = fitLine(left, maxPx - getTextWidth(r) - getTextWidth('  '))
  const space = getTextWidth(' ')
  const gap = Math.max(1, Math.floor((maxPx - getTextWidth(l) - getTextWidth(r)) / space))
  return `${l}${' '.repeat(gap)}${r}`
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

/** At most `max` wrapped lines; the last one is cut with '...' when there is more. */
export function clampLines(text: string, max: number, maxPx: number): string[] {
  const lines = wrapLines(text, maxPx)
  if (lines.length <= max) return lines
  return [...lines.slice(0, max - 1), fitLine(`${lines[max - 1]} ${lines[max]}`, maxPx)]
}

/** The last `max` wrapped lines (live transcript tail). */
export function tailLines(text: string, max: number, maxPx: number): string[] {
  const lines = wrapLines(text, maxPx)
  return lines.slice(Math.max(0, lines.length - max))
}
