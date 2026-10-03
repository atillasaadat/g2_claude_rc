import { describe, expect, test } from 'bun:test'
import { DEFAULT_GESTURES, parseGestureMap, resolveGesture, validateGestureMap, type GestureMap } from '../src/gestures'

describe('default gesture map', () => {
  test('is valid', () => {
    expect(validateGestureMap(DEFAULT_GESTURES)).toEqual([])
  })

  test('matches the agreed defaults', () => {
    expect(resolveGesture(DEFAULT_GESTURES, 'feed', 'tap')).toBe('menu.open')
    expect(resolveGesture(DEFAULT_GESTURES, 'feed', 'double_tap')).toBe('app.exit')
    expect(resolveGesture(DEFAULT_GESTURES, 'card', 'scroll_down')).toBe('card.next')
    expect(resolveGesture(DEFAULT_GESTURES, 'card', 'tap')).toBe('card.confirm')
    expect(resolveGesture(DEFAULT_GESTURES, 'card', 'double_tap')).toBe('nav.back')
    expect(resolveGesture(DEFAULT_GESTURES, 'voice', 'tap')).toBe('voice.send')
    expect(resolveGesture(DEFAULT_GESTURES, 'voice', 'double_tap')).toBe('voice.cancel')
    expect(resolveGesture(DEFAULT_GESTURES, 'reply', 'scroll_down')).toBe('page.next')
    expect(resolveGesture(DEFAULT_GESTURES, 'reply', 'double_tap')).toBe('nav.back')
  })
})

describe('validateGestureMap', () => {
  const withFeed = (feed: Partial<GestureMap['feed']>): GestureMap => ({ ...DEFAULT_GESTURES, feed: { ...DEFAULT_GESTURES.feed, ...feed } })

  test('requires a way to exit the app from the feed', () => {
    expect(validateGestureMap(withFeed({ double_tap: 'none' }))).toContain('feed: no gesture exits the app')
  })

  test('requires a way off every other screen', () => {
    const map: GestureMap = { ...DEFAULT_GESTURES, reply: { tap: 'none', double_tap: 'none', scroll_up: 'page.prev', scroll_down: 'page.next' } }
    expect(validateGestureMap(map)).toContain('reply: no gesture leaves this screen')
  })

  test('rejects actions that do not belong on a screen', () => {
    expect(validateGestureMap(withFeed({ tap: 'card.confirm' as never }))).toContain('feed.tap: card.confirm is not available here')
  })

  test('rejects a voice map without send', () => {
    const map: GestureMap = { ...DEFAULT_GESTURES, voice: { tap: 'voice.cancel', double_tap: 'voice.cancel', scroll_up: 'none', scroll_down: 'none' } }
    expect(validateGestureMap(map)).toContain('voice: no gesture sends the prompt')
  })
})

describe('parseGestureMap', () => {
  test('round trips the defaults', () => {
    expect(parseGestureMap(JSON.stringify(DEFAULT_GESTURES))).toEqual(DEFAULT_GESTURES)
  })

  test('falls back to defaults for garbage, unknown actions, or invalid maps', () => {
    expect(parseGestureMap('')).toEqual(DEFAULT_GESTURES)
    expect(parseGestureMap('{nope')).toEqual(DEFAULT_GESTURES)
    expect(parseGestureMap(JSON.stringify({ ...DEFAULT_GESTURES, feed: { ...DEFAULT_GESTURES.feed, tap: 'rm -rf' } }))).toEqual(DEFAULT_GESTURES)
    expect(parseGestureMap(JSON.stringify({ ...DEFAULT_GESTURES, feed: { ...DEFAULT_GESTURES.feed, double_tap: 'none' } }))).toEqual(DEFAULT_GESTURES)
  })
})

describe('menu gestures', () => {
  test('feed tap opens the menu by default, and the menu uses card gestures', () => {
    expect(resolveGesture(DEFAULT_GESTURES, 'feed', 'tap')).toBe('menu.open')
    expect(resolveGesture(DEFAULT_GESTURES, 'menu', 'scroll_down')).toBe('card.next')
    expect(resolveGesture(DEFAULT_GESTURES, 'menu', 'tap')).toBe('card.confirm')
    expect(resolveGesture(DEFAULT_GESTURES, 'menu', 'double_tap')).toBe('nav.back')
  })

  test('a Phase 3 map with feed tap on voice.start is still valid', () => {
    const old = { ...DEFAULT_GESTURES, feed: { ...DEFAULT_GESTURES.feed, tap: 'voice.start' as const } }
    expect(validateGestureMap(old)).toEqual([])
  })
})
