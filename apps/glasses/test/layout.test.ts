import { describe, expect, test } from 'bun:test'
import { getTextWidth } from '@evenrealities/pretext'
import { BODY_LINES, INNER_WIDTH, fitLine, paginate, wrapLines } from '../src/layout'

describe('fitLine', () => {
  test('keeps short text and truncates long text to the pixel budget', () => {
    expect(fitLine('hello')).toBe('hello')
    const long = fitLine('x'.repeat(500))
    expect(getTextWidth(long)).toBeLessThanOrEqual(INNER_WIDTH)
    expect(long.endsWith('...')).toBe(true)
  })

  test('flattens newlines', () => {
    expect(fitLine('a\nb')).toBe('a b')
  })
})

describe('wrapLines', () => {
  test('every line fits the inner width', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(30)
    const lines = wrapLines(text)
    expect(lines.length).toBeGreaterThan(5)
    for (const l of lines) expect(getTextWidth(l)).toBeLessThanOrEqual(INNER_WIDTH)
  })

  test('keeps explicit line breaks and blank lines', () => {
    expect(wrapLines('one\n\ntwo')).toEqual(['one', '', 'two'])
  })

  test('hard-breaks a single word wider than the line', () => {
    const lines = wrapLines('a'.repeat(400))
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(getTextWidth(l)).toBeLessThanOrEqual(INNER_WIDTH)
    expect(lines.join('')).toBe('a'.repeat(400))
  })

  test('does not lose words', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau'
    expect(wrapLines(text).join(' ')).toBe(text)
  })
})

describe('paginate', () => {
  test('splits into pages of BODY_LINES lines', () => {
    const text = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n')
    const pages = paginate(text)
    expect(pages.length).toBe(Math.ceil(25 / BODY_LINES))
    expect(pages[0]!.split('\n').length).toBe(BODY_LINES)
  })

  test('always returns at least one page', () => {
    expect(paginate('')).toEqual([''])
  })
})
