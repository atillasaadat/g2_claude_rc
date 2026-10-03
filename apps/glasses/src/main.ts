// G2 Claude Code: glasses app entry. Feed, reply view, feed menu with Stop
// (Phase 4), permission cards (Phase 5), voice prompts (Phase 6). Questions (7) come later.

import { AudioInputSource, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { fromBase64Url } from '@g2cc/protocol'
import { BridgeQueue } from './bridge-queue'
import { Display } from './display'
import { DEFAULT_GESTURES, type GestureMap } from './gestures'
import { toSignal } from './input'
import { Link } from './link'
import { render } from './render'
import { BYTES_PER_SECOND } from './asr/wav'
import { transcribe } from './asr/stt'
import { initialState, micWanted, reduce, type AppState, type Msg } from './state'
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
const MAX_RECORDING_BYTES = 60 * BYTES_PER_SECOND
const MIN_RECORDING_BYTES = 0.3 * BYTES_PER_SECOND

let micOn = false
let pcm: Uint8Array[] = []
let pcmBytes = 0
let transcribingAttempt = 0

/** Keeps the bridge mic in step with micWanted(state). Calls go through the shared queue. */
function syncMic(): void {
  const wanted = micWanted(state)
  if (wanted === micOn) return
  micOn = wanted
  if (wanted) {
    pcm = []
    pcmBytes = 0
  }
  queue
    .run('audioControl', () => (wanted ? bridge.audioControl(true, AudioInputSource.Glasses) : bridge.audioControl(false)))
    .catch(err => log('mic control failed:', (err as Error).message))
}

function onAudio(chunk: Uint8Array): void {
  if (!micOn) return
  pcm.push(chunk)
  pcmBytes += chunk.length
  if (pcmBytes >= MAX_RECORDING_BYTES) dispatch({ type: 'voice_limit' })
}

/** Starts transcription once per attempt, when the reducer enters 'transcribing'. */
function syncTranscription(): void {
  const { phase, attempt } = state.voice
  if (phase !== 'transcribing' || attempt === transcribingAttempt) return
  transcribingAttempt = attempt
  const audio = pcm
  const bytes = pcmBytes
  pcm = []
  pcmBytes = 0
  if (FAKE_STT) {
    setTimeout(() => dispatch({ type: 'transcript', attempt, text: FAKE_STT, now: Date.now() }), 300)
    return
  }
  if (bytes < MIN_RECORDING_BYTES) {
    dispatch({ type: 'transcript_error', attempt, message: "Didn't catch that" })
    return
  }
  transcribe(audio, { apiKey: STT_KEY })
    .then(text => dispatch({ type: 'transcript', attempt, text, now: Date.now() }))
    .catch(err => dispatch({ type: 'transcript_error', attempt, message: (err as Error).message }))
}

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
  if (started) {
    syncMic()
    syncTranscription()
  }
  for (const effect of result.effects) {
    if (effect.type === 'exit') void bridge.shutDownPageContainer(1)
    if (effect.type === 'send') {
      link.send(effect.kind, effect.body).catch(err => log(`could not send ${effect.kind}:`, (err as Error).message))
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
    onAudio(chunk)
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
  link.disconnect()
  unsubscribe()
}
window.addEventListener('beforeunload', cleanup)
