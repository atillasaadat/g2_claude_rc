// Gesture map: (screen, gesture) -> action, so users can remap input from the
// companion UI. The SDK only reports tap, double tap, and scroll up/down
// (no long press), see docs/decisions.md. The R1 ring sends the same events.

export const SCREENS = ['timeline', 'card', 'voice'] as const
export const GESTURES = ['tap', 'double_tap', 'scroll_up', 'scroll_down'] as const

export type Screen = (typeof SCREENS)[number]
export type Gesture = (typeof GESTURES)[number]

/** Actions each screen understands. 'none' is always allowed. */
export const ACTIONS = {
  timeline: ['none', 'menu.open', 'voice.start', 'app.exit', 'live.or.exit', 'timeline.up', 'timeline.down', 'timeline.live'],
  card: ['none', 'nav.back', 'card.prev', 'card.next', 'card.confirm'],
  voice: ['none', 'voice.send', 'voice.cancel'],
} as const satisfies Record<Screen, readonly string[]>

export type Action = (typeof ACTIONS)[Screen][number]
export type GestureMap = { [S in Screen]: Record<Gesture, (typeof ACTIONS)[S][number]> }

export const DEFAULT_GESTURES: GestureMap = {
  timeline: { tap: 'menu.open', double_tap: 'live.or.exit', scroll_up: 'timeline.up', scroll_down: 'timeline.down' },
  card: { tap: 'card.confirm', double_tap: 'nav.back', scroll_up: 'card.prev', scroll_down: 'card.next' },
  voice: { tap: 'voice.send', double_tap: 'voice.cancel', scroll_up: 'none', scroll_down: 'none' },
}

/** The menu and question cards are cards too, so they share the card row of the map. */
export function resolveGesture(map: GestureMap, screen: Screen | 'menu' | 'question', gesture: Gesture): Action {
  return map[screen === 'menu' || screen === 'question' ? 'card' : screen][gesture]
}

/** Returns human-readable problems; empty means valid. */
export function validateGestureMap(map: GestureMap): string[] {
  const errors: string[] = []
  for (const screen of SCREENS) {
    const allowed: readonly string[] = ACTIONS[screen]
    for (const g of GESTURES) {
      const action = map[screen]?.[g]
      if (!allowed.includes(action)) errors.push(`${screen}.${g}: ${String(action)} is not available here`)
    }
  }
  const actions = (s: Screen): string[] => GESTURES.map(g => map[s]?.[g])
  if (!actions('timeline').some(a => a === 'app.exit' || a === 'live.or.exit')) errors.push('timeline: no gesture exits the app')
  if (!actions('card').includes('nav.back')) errors.push('card: no gesture leaves this screen')
  if (!actions('voice').includes('voice.send')) errors.push('voice: no gesture sends the prompt')
  if (!actions('voice').includes('voice.cancel')) errors.push('voice: no gesture cancels')
  return errors
}

/** Parses a stored map. Anything unreadable or invalid (including older layouts) falls back to the defaults. */
export function parseGestureMap(raw: string): GestureMap {
  try {
    const parsed = JSON.parse(raw) as GestureMap
    return validateGestureMap(parsed).length === 0 ? parsed : DEFAULT_GESTURES
  } catch {
    return DEFAULT_GESTURES
  }
}
