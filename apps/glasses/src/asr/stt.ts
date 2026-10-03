// Speech to text via the Groq Whisper API (free tier, chosen in Phase 0).
// Batch: the whole recording is posted after the user taps done.
//
// The key comes from VITE_STT_API_KEY in .env.local and is baked into the
// bundle, which is acceptable for a personal sideload only: never publish
// the .ehpk. app.json whitelists https://api.groq.com.

import { pcmToWav } from './wav'

export const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
export const GROQ_MODEL = 'whisper-large-v3-turbo'
/** Biases Whisper toward the words people say to a coding agent. */
const VOCABULARY = 'Claude, Claude Code, git, GitHub, Bash, npm, bun, TypeScript, JavaScript, Python, pull request, commit, refactor, lint, repo.'

export class SttError extends Error {}

export interface TranscribeOptions {
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export async function transcribe(pcm: readonly Uint8Array[], opts: TranscribeOptions): Promise<string> {
  if (!opts.apiKey) throw new SttError('No Groq API key: set VITE_STT_API_KEY in .env.local')
  const form = new FormData()
  form.append('file', new File([pcmToWav(pcm) as BlobPart], 'speech.wav', { type: 'audio/wav' }))
  form.append('model', GROQ_MODEL)
  form.append('language', 'en')
  form.append('response_format', 'json')
  form.append('temperature', '0')
  form.append('prompt', VOCABULARY)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000)
  let res: Response
  try {
    res = await (opts.fetchImpl ?? fetch)(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal: controller.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new SttError('Transcription timed out')
    throw new SttError('Could not reach Groq')
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 401) throw new SttError('Groq rejected the API key')
  if (res.status === 429) throw new SttError('Groq free-tier limit reached, try again shortly')
  if (!res.ok) throw new SttError(`Transcription failed (HTTP ${res.status})`)
  const body = (await res.json()) as { text?: unknown }
  return typeof body.text === 'string' ? body.text.trim() : ''
}
