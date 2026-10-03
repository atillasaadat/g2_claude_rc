import { describe, expect, test } from 'bun:test'
import { parseVoice } from '../src/voice'
import { pcmToWav, SAMPLE_RATE } from '../src/asr/wav'
import { transcribe, SttError } from '../src/asr/stt'

describe('parseVoice', () => {
  test.each(['stop', 'Stop.', 'STOP!', 'stop it', 'stop claude', 'Stop, Claude.', 'please stop'])('%p is stop', t => {
    expect(parseVoice(t)).toEqual({ type: 'stop' })
  })

  test.each(['cancel', 'Cancel.', 'cancel that'])('%p is cancel', t => {
    expect(parseVoice(t)).toEqual({ type: 'cancel' })
  })

  test.each([
    ['approve', 'approve'],
    ['Approve.', 'approve'],
    ['allow', 'approve'],
    ['yes approve', 'approve'],
    ['deny', 'deny'],
    ['Deny it.', 'deny'],
  ])('%p is %s', (t, type) => {
    expect(parseVoice(t)).toEqual({ type } as never)
  })

  test('longer sentences containing a keyword are prompts, not commands', () => {
    expect(parseVoice('stop the dev server and run the tests')).toEqual({ type: 'prompt', text: 'stop the dev server and run the tests' })
    expect(parseVoice('approve the pull request on GitHub')).toEqual({
      type: 'prompt',
      text: 'approve the pull request on GitHub',
    })
  })

  test.each(['', '   ', '.', 'you', 'Thank you.', 'Thanks for watching!', 'Bye.'])('%p is empty (silence or a Whisper hallucination)', t => {
    expect(parseVoice(t)).toEqual({ type: 'empty' })
  })

  test('prompts are trimmed', () => {
    expect(parseVoice('  Run the unit tests.  ')).toEqual({ type: 'prompt', text: 'Run the unit tests.' })
  })
})

describe('pcmToWav', () => {
  test('writes a 16 kHz mono 16-bit RIFF header followed by the samples', () => {
    const pcm = [Uint8Array.of(1, 2, 3, 4), Uint8Array.of(5, 6)]
    const wav = pcmToWav(pcm)
    const v = new DataView(wav.buffer)
    const str = (o: number) => String.fromCharCode(...wav.slice(o, o + 4))
    expect(str(0)).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(36 + 6)
    expect(str(8)).toBe('WAVE')
    expect(v.getUint16(22, true)).toBe(1) // mono
    expect(v.getUint32(24, true)).toBe(SAMPLE_RATE)
    expect(v.getUint16(34, true)).toBe(16)
    expect(str(36)).toBe('data')
    expect(v.getUint32(40, true)).toBe(6)
    expect([...wav.slice(44)]).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('transcribe (Groq)', () => {
  const pcm = [new Uint8Array(3200)]

  test('posts a WAV to the Groq endpoint with the key and returns the text', async () => {
    let seen: { url: string; auth: string | null; form: FormData } | null = null
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get('authorization'), form: init.body as FormData }
      return Response.json({ text: ' run the tests ' })
    }) as unknown as typeof fetch
    expect(await transcribe(pcm, { apiKey: 'k', fetchImpl })).toBe('run the tests')
    expect(seen!.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(seen!.auth).toBe('Bearer k')
    expect(seen!.form.get('model')).toBe('whisper-large-v3-turbo')
    expect(seen!.form.get('language')).toBe('en')
    expect((seen!.form.get('file') as File).type).toBe('audio/wav')
  })

  test.each([
    [401, 'Groq rejected the API key'],
    [429, 'Groq free-tier limit reached, try again shortly'],
    [500, 'Transcription failed (HTTP 500)'],
  ])('maps HTTP %d to a readable error', async (status, message) => {
    const fetchImpl = (async () => new Response('{}', { status })) as unknown as typeof fetch
    await expect(transcribe(pcm, { apiKey: 'k', fetchImpl })).rejects.toThrow(new SttError(message))
  })

  test('refuses to run without a key', async () => {
    await expect(transcribe(pcm, { apiKey: '' })).rejects.toThrow('No Groq API key')
  })

  test('times out', async () => {
    const fetchImpl = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch
    await expect(transcribe(pcm, { apiKey: 'k', fetchImpl, timeoutMs: 20 })).rejects.toThrow('Transcription timed out')
  })
})
