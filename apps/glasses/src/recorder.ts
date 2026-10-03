// Mic audio buffering and Groq transcription, driven by app state.
//
// Live text: while listening, the audio so far is re-transcribed every
// PARTIAL_MS so the voice box fills in as the user speaks (Groq is batch-only).
// Groq's free tier allows 20 requests per minute, so partials stay under
// PARTIALS_PER_MINUTE (leaving room for final transcriptions) and stop for the
// rest of a recording after any error, such as a 429.

import { BYTES_PER_SECOND } from './asr/wav'
import type { Msg } from './state'

export const PARTIAL_MS = 2_500
export const PARTIALS_PER_MINUTE = 14
const MAX_RECORDING_BYTES = 60 * BYTES_PER_SECOND
const MIN_RECORDING_BYTES = 0.3 * BYTES_PER_SECOND
/** Partials need at least this much audio to be worth a request. */
const MIN_PARTIAL_BYTES = 1 * BYTES_PER_SECOND

export type Transcriber = (pcm: readonly Uint8Array[]) => Promise<string>

export interface RecorderOptions {
  dispatch: (msg: Msg) => void
  transcribe: Transcriber
  /** Dev only: a canned transcript so tests can drive the flow without speaking. */
  fakeTranscript?: string
  now?: () => number
}

export class VoiceRecorder {
  private pcm: Uint8Array[] = []
  private bytes = 0
  private attempt = 0
  private finalAttempt = 0
  private partialTimer: ReturnType<typeof setInterval> | null = null
  private partialInFlight = false
  private partialsOff = false
  private readonly requests: number[] = []
  private readonly now: () => number

  constructor(private readonly opts: RecorderOptions) {
    this.now = opts.now ?? Date.now
  }

  /** Call when the mic turns on (a new attempt) or off. */
  setListening(on: boolean, attempt: number): void {
    if (on) {
      this.pcm = []
      this.bytes = 0
      this.attempt = attempt
      this.partialsOff = false
      this.partialTimer ??= setInterval(() => this.partial(), PARTIAL_MS)
    } else if (this.partialTimer) {
      clearInterval(this.partialTimer)
      this.partialTimer = null
    }
  }

  onAudio(chunk: Uint8Array): void {
    if (!this.partialTimer) return
    this.pcm.push(chunk)
    this.bytes += chunk.length
    if (this.bytes >= MAX_RECORDING_BYTES) this.opts.dispatch({ type: 'voice_limit' })
  }

  /** Starts the final transcription once per attempt, when state enters 'transcribing'. */
  finish(attempt: number): void {
    if (attempt === this.finalAttempt) return
    this.finalAttempt = attempt
    const audio = this.pcm
    const bytes = this.bytes
    this.pcm = []
    this.bytes = 0
    const { dispatch } = this.opts
    if (this.opts.fakeTranscript) {
      setTimeout(() => dispatch({ type: 'transcript', attempt, text: this.opts.fakeTranscript!, now: this.now() }), 300)
      return
    }
    if (bytes < MIN_RECORDING_BYTES) {
      dispatch({ type: 'transcript_error', attempt, message: "Didn't catch that" })
      return
    }
    this.count()
    this.opts
      .transcribe(audio)
      .then(text => dispatch({ type: 'transcript', attempt, text, now: this.now() }))
      .catch(err => dispatch({ type: 'transcript_error', attempt, message: (err as Error).message }))
  }

  private count(): void {
    const t = this.now()
    this.requests.push(t)
    while (this.requests.length && t - this.requests[0]! > 60_000) this.requests.shift()
  }

  private partial(): void {
    if (this.partialInFlight || this.partialsOff || this.bytes < MIN_PARTIAL_BYTES) return
    const t = this.now()
    while (this.requests.length && t - this.requests[0]! > 60_000) this.requests.shift()
    if (this.requests.length >= PARTIALS_PER_MINUTE) return
    const attempt = this.attempt
    if (this.opts.fakeTranscript) {
      const words = this.opts.fakeTranscript.split(' ')
      this.opts.dispatch({ type: 'partial', attempt, text: words.slice(0, Math.ceil(words.length / 2)).join(' ') })
      return
    }
    this.partialInFlight = true
    this.count()
    this.opts
      .transcribe([...this.pcm])
      .then(text => this.opts.dispatch({ type: 'partial', attempt, text }))
      .catch(() => {
        this.partialsOff = true // e.g. 429: keep the quota for the final transcription
      })
      .finally(() => {
        this.partialInFlight = false
      })
  }
}
