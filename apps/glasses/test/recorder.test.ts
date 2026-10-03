import { afterEach, describe, expect, test } from 'bun:test'
import { PARTIAL_MS, PARTIALS_PER_MINUTE, VoiceRecorder } from '../src/recorder'
import { BYTES_PER_SECOND } from '../src/asr/wav'
import type { Msg } from '../src/state'

const second = () => new Uint8Array(BYTES_PER_SECOND)
let recorders: VoiceRecorder[] = []
afterEach(() => {
  recorders.forEach(r => r.setListening(false, 0))
  recorders = []
})

function setup(transcribe: (n: number) => Promise<string>) {
  const msgs: Msg[] = []
  let calls = 0
  const r = new VoiceRecorder({ dispatch: m => msgs.push(m), transcribe: () => transcribe(++calls) })
  recorders.push(r)
  return { r, msgs, calls: () => calls }
}

describe('VoiceRecorder', () => {
  test('sends partial transcripts while listening', async () => {
    const { r, msgs } = setup(async n => `partial ${n}`)
    r.setListening(true, 1)
    r.onAudio(second())
    r.onAudio(second())
    await Bun.sleep(PARTIAL_MS + 100)
    expect(msgs).toContainEqual({ type: 'partial', attempt: 1, text: 'partial 1' })
  }, 10_000)

  test('skips partials with too little audio', async () => {
    const { r, calls } = setup(async () => 'x')
    r.setListening(true, 1)
    r.onAudio(new Uint8Array(100))
    await Bun.sleep(PARTIAL_MS + 100)
    expect(calls()).toBe(0)
  }, 10_000)

  test('stops partials after an error, keeping the quota for the final transcript', async () => {
    const { r, calls } = setup(async () => {
      throw new Error('429')
    })
    r.setListening(true, 1)
    r.onAudio(second())
    await Bun.sleep(2 * PARTIAL_MS + 200)
    expect(calls()).toBe(1)
  }, 10_000)

  test('final transcription runs once per attempt, and short audio is rejected', async () => {
    const { r, msgs, calls } = setup(async () => 'run the tests')
    r.setListening(true, 1)
    r.onAudio(second())
    r.setListening(false, 1)
    r.finish(1)
    r.finish(1)
    await Bun.sleep(20)
    expect(calls()).toBe(1)
    expect(msgs.at(-1)).toMatchObject({ type: 'transcript', attempt: 1, text: 'run the tests' })

    r.setListening(true, 2)
    r.onAudio(new Uint8Array(10))
    r.setListening(false, 2)
    r.finish(2)
    expect(msgs.at(-1)).toEqual({ type: 'transcript_error', attempt: 2, message: "Didn't catch that" })
  })

  test('caps the request rate below the Groq free tier', () => {
    expect(PARTIALS_PER_MINUTE).toBeLessThan(20)
  })

  test('the 60 s cap ends recording', () => {
    const { r, msgs } = setup(async () => 'x')
    r.setListening(true, 1)
    r.onAudio(new Uint8Array(60 * BYTES_PER_SECOND))
    expect(msgs).toContainEqual({ type: 'voice_limit' })
  })
})
