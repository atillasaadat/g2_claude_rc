// What the phone view shows about the saved Groq key, without showing the key:
// a masked form (its first and last 4 characters, as Groq's console lists
// keys) and a short fingerprint to compare, plus a live check with Groq.

/** Lists models: the cheapest call that proves a key works. Costs no transcription quota. */
export const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models'

export type KeyCheck = 'valid' | 'invalid' | 'unknown'

/** gsk_…wxyz */
export function maskKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '…'
}

/** First 32 bits of SHA-256(key), as XXXX-XXXX. Enough to tell two keys apart, useless for recovering one. */
export async function keyFingerprint(key: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
  const hex = Array.from(d.slice(0, 4), b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
  return `${hex.slice(0, 4)}-${hex.slice(4)}`
}

/** `invalid` only when Groq says so (401 or 403); offline, rate limits and errors are `unknown`. */
export async function checkGroqKey(key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): Promise<KeyCheck> {
  try {
    const res = await fetchImpl(GROQ_MODELS_URL, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) })
    if (res.ok) return 'valid'
    if (res.status === 401 || res.status === 403) return 'invalid'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
