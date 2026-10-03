import { describe, expect, test } from 'bun:test'
import { deriveRoomId, generateKey, importKey, openFrame, sealFrame } from '../src/crypto'
import { FRAME_VERSION } from '../src/limits'

const enc = new TextEncoder()
const dec = new TextDecoder()

async function setup() {
  const raw = generateKey()
  const key = await importKey(raw)
  const roomId = await deriveRoomId(raw)
  return { raw, key, roomId }
}

describe('generateKey', () => {
  test('returns 32 random bytes', () => {
    const a = generateKey()
    const b = generateKey()
    expect(a).toBeInstanceOf(Uint8Array)
    expect(a.length).toBe(32)
    expect(a).not.toEqual(b)
  })
})

describe('importKey', () => {
  test('rejects keys that are not 32 bytes', async () => {
    await expect(importKey(new Uint8Array(16))).rejects.toThrow()
  })
})

describe('deriveRoomId', () => {
  test('is deterministic, 32 lowercase hex chars', async () => {
    const raw = generateKey()
    const a = await deriveRoomId(raw)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(await deriveRoomId(raw)).toBe(a)
  })

  test('differs per key', async () => {
    expect(await deriveRoomId(generateKey())).not.toBe(await deriveRoomId(generateKey()))
  })
})

describe('sealFrame / openFrame', () => {
  test('round trips plaintext', async () => {
    const { key, roomId } = await setup()
    const frame = await sealFrame(key, roomId, 'c2g', enc.encode('hello glasses'))
    expect(frame[0]).toBe(FRAME_VERSION)
    const out = await openFrame(key, roomId, 'c2g', frame)
    expect(dec.decode(out)).toBe('hello glasses')
  })

  test('uses a fresh nonce per frame', async () => {
    const { key, roomId } = await setup()
    const a = await sealFrame(key, roomId, 'c2g', enc.encode('same'))
    const b = await sealFrame(key, roomId, 'c2g', enc.encode('same'))
    expect(a).not.toEqual(b)
  })

  test('fails with the wrong key', async () => {
    const { key, roomId } = await setup()
    const other = await importKey(generateKey())
    const frame = await sealFrame(key, roomId, 'c2g', enc.encode('x'))
    await expect(openFrame(other, roomId, 'c2g', frame)).rejects.toThrow()
  })

  test('fails when any byte is tampered', async () => {
    const { key, roomId } = await setup()
    const frame = await sealFrame(key, roomId, 'g2c', enc.encode('approve it'))
    const last = frame.length - 1
    frame[last] = (frame[last] ?? 0) ^ 0x01
    await expect(openFrame(key, roomId, 'g2c', frame)).rejects.toThrow()
  })

  test('fails when replayed in the other direction (reflection)', async () => {
    const { key, roomId } = await setup()
    const frame = await sealFrame(key, roomId, 'c2g', enc.encode('x'))
    await expect(openFrame(key, roomId, 'g2c', frame)).rejects.toThrow()
  })

  test('fails when moved to another room', async () => {
    const { key, roomId } = await setup()
    const frame = await sealFrame(key, roomId, 'c2g', enc.encode('x'))
    await expect(openFrame(key, 'f'.repeat(32), 'c2g', frame)).rejects.toThrow()
  })

  test('rejects truncated frames and unknown versions', async () => {
    const { key, roomId } = await setup()
    await expect(openFrame(key, roomId, 'c2g', new Uint8Array(5))).rejects.toThrow()
    const frame = await sealFrame(key, roomId, 'c2g', enc.encode('x'))
    frame[0] = 99
    await expect(openFrame(key, roomId, 'c2g', frame)).rejects.toThrow()
  })
})

describe('relay auth token', () => {
  test('is stable per key and room, and differs across rooms and keys', async () => {
    const { relayAuthToken, generateKey } = await import('../src/crypto')
    const k = generateKey()
    expect(await relayAuthToken(k, 'a'.repeat(32))).toBe(await relayAuthToken(k, 'a'.repeat(32)))
    expect(await relayAuthToken(k, 'a'.repeat(32))).not.toBe(await relayAuthToken(k, 'b'.repeat(32)))
    expect(await relayAuthToken(generateKey(), 'a'.repeat(32))).not.toBe(await relayAuthToken(k, 'a'.repeat(32)))
    expect(await relayAuthToken(k, 'a'.repeat(32))).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})
