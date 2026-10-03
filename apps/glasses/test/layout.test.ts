import { describe, expect, test } from 'bun:test'
import { getTextWidth } from '@evenrealities/pretext'
import { clampLines, fitLine, HEADER, HEADER_WIDTH, innerLines, overlayBox, sideBox, spread, tailLines, TIMELINE, TIMELINE_LINES, TIMELINE_WIDTH, wrapLines } from '../src/layout'

describe('geometry', () => {
  test('header holds one line, the timeline nine', () => {
    expect(innerLines(HEADER)).toBe(1)
    expect(TIMELINE_LINES).toBe(9)
    expect(TIMELINE.y + TIMELINE.h).toBe(288)
  })

  test('overlay boxes up to 8 lines stay on screen', () => {
    for (let n = 1; n <= 8; n++) {
      const b = overlayBox(n)
      expect(innerLines(b)).toBe(n)
      expect(b.y + b.h).toBeLessThanOrEqual(288)
      const side = sideBox(n)
      expect(side.x + side.w).toBeLessThanOrEqual(576)
    }
  })
})

describe('text fitting', () => {
  test('fitLine truncates to the budget and flattens newlines', () => {
    expect(fitLine('a\nb')).toBe('a b')
    const long = fitLine('x'.repeat(500))
    expect(getTextWidth(long)).toBeLessThanOrEqual(TIMELINE_WIDTH)
    expect(long.endsWith('...')).toBe(true)
  })

  test('spread pushes the right text to the edge and fits', () => {
    const line = spread('● g2cc-sandbox · idle', 'auto', HEADER_WIDTH)
    expect(line.startsWith('● g2cc-sandbox · idle ')).toBe(true)
    expect(line.endsWith('auto')).toBe(true)
    expect(getTextWidth(line)).toBeLessThanOrEqual(HEADER_WIDTH)
    expect(getTextWidth(line)).toBeGreaterThan(HEADER_WIDTH - 12)
    expect(getTextWidth(spread('x'.repeat(300), 'auto', HEADER_WIDTH))).toBeLessThanOrEqual(HEADER_WIDTH)
  })

  test('wrapLines keeps every word, every line fits, long words hard-break', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau '.repeat(3).trim()
    const lines = wrapLines(text)
    expect(lines.join(' ')).toBe(text)
    for (const l of lines) expect(getTextWidth(l)).toBeLessThanOrEqual(TIMELINE_WIDTH)
    expect(wrapLines('a'.repeat(400)).join('')).toBe('a'.repeat(400))
    expect(wrapLines('one\n\ntwo')).toEqual(['one', '', 'two'])
  })

  test('clampLines cuts the last kept line; tailLines keeps the end', () => {
    const text = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ').repeat(3)
    const clamped = clampLines(text, 2, 200)
    expect(clamped).toHaveLength(2)
    expect(clamped[1]!.endsWith('...')).toBe(true)
    const tail = tailLines('first line goes here and then the last words', 1, 120)
    expect(tail).toHaveLength(1)
    expect(tail[0]!.endsWith('words')).toBe(true)
  })
})
