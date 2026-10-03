// G2 Claude Code: glasses app entry. A continuous timeline with overlays for
// the menu, permission cards, questions, and voice (live transcript).

import { AudioInputSource, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { fromBase64Url } from '@g2cc/protocol'
import { BridgeQueue } from './bridge-queue'
import { Display } from './display'
import { DEFAULT_GESTURES, type GestureMap } from './gestures'
import { toSignal } from './input'
import { Link } from './link'
import { frameOf, render } from './render'
import { transcribe } from './asr/stt'
import { VoiceRecorder } from './recorder'
import { initialState, isAnimating, micWanted, reduce, type AppState, type Msg } from './state'
import { Storage } from './storage'
import { mirror, mountUi, setGestureMap, setStatus } from './ui'

const log = (...args: unknown[]): void => console.log('[g2cc]', ...args)

let state: AppState = initialState()
let gestures: GestureMap = DEFAULT_GESTURES
let display: Display | null = null
let started = false

const STT_KEY = (import.meta.env.VITE_STT_API_KEY as string | undefined) ?? ''
// Dev only: a canned transcript so simulator tests can drive the voice flow without speaking.
const FAKE_STT = import.meta.env.DEV ? ((import.meta.env.VITE_G2CC_FAKE_STT as string | undefined) ?? '') : ''
const TICK_MS = 250

let micOn = false
let ticker: ReturnType<typeof setInterval> | null = null
let lastLogged = ''

const recorder = new VoiceRecorder({
  dispatch: msg => dispatch(msg),
  transcribe: pcm => transcribe(pcm, { apiKey: STT_KEY }),
  ...(FAKE_STT ? { fakeTranscript: FAKE_STT } : {}),
})

/** Keeps the bridge mic in step with micWanted(state). Calls go through the shared queue. */
function syncMic(): void {
  const wanted = micWanted(state)
  if (wanted === micOn) return
  micOn = wanted
  recorder.setListening(wanted, state.voice.attempt)
  queue
    .run('audioControl', () => (wanted ? bridge.audioControl(true, AudioInputSource.Glasses) : bridge.audioControl(false)))
    .catch(err => log('mic control failed:', (err as Error).message))
}

/** Runs the animation clock only while something animates (dots, pulse, fade). */
function syncTicker(): void {
  const wanted = isAnimating(state)
  if (wanted && !ticker) ticker = setInterval(() => dispatch({ type: 'tick', now: Date.now() }), TICK_MS)
  if (!wanted && ticker) {
    clearInterval(ticker)
    ticker = null
  }
}

function paint(): void {
  const scene = render(state)
  const frame = frameOf(scene)
  display?.show(scene)
  mirror(frame)
  setStatus(state.link, state.paired)
  // Dev only: lets simulator automation assert on exactly what was drawn.
  const logged = JSON.stringify(frame)
  if (import.meta.env.DEV && started && logged !== lastLogged) log('frame', logged)
  lastLogged = logged
}

function dispatch(msg: Msg): void {
  const result = reduce(state, msg)
  state = result.state
  paint()
  if (started) {
    syncMic()
    if (state.voice.phase === 'transcribing') recorder.finish(state.voice.attempt)
    syncTicker()
  }
  for (const effect of result.effects) {
    if (effect.type === 'exit') void bridge.shutDownPageContainer(1)
    if (effect.type === 'send') {
      link.send(effect.kind, effect.body, effect.sid).catch(err => log(`could not send ${effect.kind}:`, (err as Error).message))
    }
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
state = reduce(state, { type: 'config', voiceAvailable: Boolean(STT_KEY || FAKE_STT) }).state

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
  const chunk = event.audioEvent?.audioPcm
  if (chunk) {
    recorder.onAudio(chunk)
    return
  }
  const signal = toSignal(event)
  if (!signal) return
  switch (signal.type) {
    case 'gesture':
      dispatch({ type: 'gesture', gesture: signal.gesture, map: gestures, now: Date.now() })
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
  if (micOn) void bridge.audioControl(false)
  recorder.setListening(false, state.voice.attempt)
  if (ticker) clearInterval(ticker)
  link.disconnect()
  unsubscribe()
}
window.addEventListener('beforeunload', cleanup)
