import { describe, expect, test } from 'bun:test'
import { DEFAULT_GESTURES, parseGestureMap, resolveGesture, validateGestureMap, type GestureMap } from '../src/gestures'

describe('gesture map', () => {
  test('defaults are valid and match the design', () => {
    expect(validateGestureMap(DEFAULT_GESTURES)).toEqual([])
    expect(resolveGesture(DEFAULT_GESTURES, 'timeline', 'tap')).toBe('menu.open')
    expect(resolveGesture(DEFAULT_GESTURES, 'timeline', 'double_tap')).toBe('live.or.exit')
    expect(resolveGesture(DEFAULT_GESTURES, 'timeline', 'scroll_up')).toBe('timeline.up')
    expect(resolveGesture(DEFAULT_GESTURES, 'timeline', 'scroll_down')).toBe('timeline.down')
    expect(resolveGesture(DEFAULT_GESTURES, 'voice', 'tap')).toBe('voice.send')
  })

  test('menu and question cards share the card row', () => {
    expect(resolveGesture(DEFAULT_GESTURES, 'menu', 'tap')).toBe('card.confirm')
    expect(resolveGesture(DEFAULT_GESTURES, 'question', 'scroll_down')).toBe('card.next')
  })

  const withTimeline = (t: Partial<GestureMap['timeline']>): GestureMap => ({ ...DEFAULT_GESTURES, timeline: { ...DEFAULT_GESTURES.timeline, ...t } })

  test('requires an exit path from the timeline', () => {
    expect(validateGestureMap(withTimeline({ double_tap: 'none' }))).toContain('timeline: no gesture exits the app')
    expect(validateGestureMap(withTimeline({ double_tap: 'none', tap: 'app.exit' }))).toEqual([])
  })

  test('rejects actions from another screen', () => {
    expect(validateGestureMap(withTimeline({ tap: 'card.confirm' as never }))).toContain('timeline.tap: card.confirm is not available here')
  })

  test('requires card back, voice send and cancel', () => {
    expect(validateGestureMap({ ...DEFAULT_GESTURES, card: { tap: 'card.confirm', double_tap: 'none', scroll_up: 'none', scroll_down: 'none' } })).toContain(
      'card: no gesture leaves this screen',
    )
    const voice = { tap: 'none', double_tap: 'none', scroll_up: 'none', scroll_down: 'none' } as const
    expect(validateGestureMap({ ...DEFAULT_GESTURES, voice })).toEqual(['voice: no gesture sends the prompt', 'voice: no gesture cancels'])
  })

  test('parse falls back to defaults for garbage and for older (feed/reply) maps', () => {
    expect(parseGestureMap(JSON.stringify(DEFAULT_GESTURES))).toEqual(DEFAULT_GESTURES)
    expect(parseGestureMap('{nope')).toEqual(DEFAULT_GESTURES)
    const phase3 = { feed: { tap: 'menu.open', double_tap: 'app.exit', scroll_up: 'feed.older', scroll_down: 'feed.newer' }, reply: {}, card: DEFAULT_GESTURES.card, voice: DEFAULT_GESTURES.voice }
    expect(parseGestureMap(JSON.stringify(phase3))).toEqual(DEFAULT_GESTURES)
  })
})
