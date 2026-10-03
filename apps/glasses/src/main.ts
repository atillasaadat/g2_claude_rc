// G2 Claude Code: glasses app entry. Phase 3 shows the live feed and reply
// view. Voice (Phase 6), permission and question cards (Phases 5, 7) come later.

import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { fromBase64Url } from '@g2cc/protocol'
import { BridgeQueue } from './bridge-queue'
import { Display } from './display'
import { DEFAULT_GESTURES, type GestureMap } from './gestures'
import { toSignal } from './input'
import { Link } from './link'
import { render } from './render'
import { initialState, reduce, type AppState, type Msg } from './state'
import { Storage } from './storage'
import { mirror, mountUi, setGestureMap, setStatus } from './ui'

const log = (...args: unknown[]): void => console.log('[g2cc]', ...args)

let state: AppState = initialState()
let gestures: GestureMap = DEFAULT_GESTURES
let display: Display | null = null
let started = false

function paint(): void {
  const frame = render(state)
  display?.show(frame)
  mirror(frame)
  setStatus(state.link, state.paired)
  // Dev only: lets simulator automation assert on exactly what was drawn.
  if (import.meta.env.DEV && started) log('frame', JSON.stringify(frame))
}

function dispatch(msg: Msg): void {
  const result = reduce(state, msg)
  state = result.state
  paint()
  for (const effect of result.effects) {
    if (effect.type === 'exit') void bridge.shutDownPageContainer(1)
  }
}

const link = new Link(dispatch)

mountUi({
  async savePairing(text) {
    const pairing = await storage.savePairing(text)
    dispatch({ type: 'paired', paired: true })
    await link.connect(pairing)
  },
  async forgetPairing() {
    await storage.forgetPairing()
    link.disconnect()
    dispatch({ type: 'paired', paired: false })
  },
  async saveGestures(map) {
    await storage.saveGestures(map)
    gestures = map
  },
})

const bridge = await waitForEvenAppBridge()
const queue = new BridgeQueue()
const storage = new Storage(bridge, queue)

/** Dev convenience: `#pair=<base64url of the pairing text>` in the app URL pairs on load. */
async function pairFromFragment(): Promise<void> {
  const m = /^#pair=([A-Za-z0-9_-]+)$/.exec(location.hash)
  if (!m?.[1]) return
  history.replaceState(null, '', location.pathname + location.search) // keep the key out of the URL bar
  try {
    await storage.savePairing(new TextDecoder().decode(fromBase64Url(m[1])))
    log('paired from URL')
  } catch (err) {
    log('pairing from URL rejected:', (err as Error).message)
  }
}

try {
  gestures = await storage.loadGestures()
} catch (err) {
  log('using default gestures:', (err as Error).message)
}
setGestureMap(gestures)
await pairFromFragment()
const stored = await storage.loadPairing().catch(() => null)
state = reduce(state, { type: 'paired', paired: stored !== null }).state

display = new Display(bridge, queue, err => log('render failed:', (err as Error).message))
try {
  await display.init(render(state))
} catch (err) {
  log((err as Error).message)
}
started = true
paint()
log('ready')
if (stored) await link.connect(stored.pairing)

let cleanedUp = false
const unsubscribe = bridge.onEvenHubEvent(event => {
  const signal = toSignal(event)
  if (!signal) return
  switch (signal.type) {
    case 'gesture':
      dispatch({ type: 'gesture', gesture: signal.gesture, map: gestures })
      return
    case 'foreground':
      display?.repaint(render(state))
      return
    case 'background':
      return
    case 'exit':
      cleanup()
  }
})

function cleanup(): void {
  if (cleanedUp) return
  cleanedUp = true
  link.disconnect()
  unsubscribe()
}
window.addEventListener('beforeunload', cleanup)
