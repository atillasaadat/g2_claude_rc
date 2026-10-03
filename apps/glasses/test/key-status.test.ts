import { describe, expect, test } from 'bun:test'
import { checkGroqKey, GROQ_MODELS_URL, keyFingerprint, maskKey } from '../src/asr/key-status'

const KEY = 'gsk_abcdefghijklmnopqrstuvwxyz0123456789'

describe('Groq key status', () => {
  test('masks all but the first and last 4 characters', () => {
    expect(maskKey(KEY)).toBe('gsk_…6789')
    expect(maskKey('short')).toBe('…')
  })

  test('fingerprints are stable, short, and differ between keys', async () => {
    const a = await keyFingerprint(KEY)
    expect(a).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/)
    expect(await keyFingerprint(KEY)).toBe(a)
    expect(await keyFingerprint(`${KEY}x`)).not.toBe(a)
  })

  test('asks Groq with the key, and reads its answer', async () => {
    const seen: Array<[string, string | null]> = []
    const fake = (status: number) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push([String(url), new Headers(init?.headers).get('authorization')])
        return new Response('{}', { status })
      }) as typeof fetch
    expect(await checkGroqKey(KEY, fake(200))).toBe('valid')
    expect(seen[0]).toEqual([GROQ_MODELS_URL, `Bearer ${KEY}`])
    expect(await checkGroqKey(KEY, fake(401))).toBe('invalid')
    expect(await checkGroqKey(KEY, fake(429))).toBe('unknown')
    expect(await checkGroqKey(KEY, (async () => { throw new Error('offline') }) as unknown as typeof fetch)).toBe('unknown')
  })
})
