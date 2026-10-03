import { describe, expect, test } from 'bun:test'
import { generateKey, importKey, deriveRoomId, sealFrame } from '../src/crypto'
import { makeEnvelope } from '../src/envelope'
import { SecureChannel } from '../src/session'

const enc = new TextEncoder()

async function pair() {
  const raw = generateKey()
  return {
    raw,
    computer: await SecureChannel.create(raw, 'computer'),
    glasses: await SecureChannel.create(raw, 'glasses'),
  }
}

describe('SecureChannel', () => {
  test('exposes the derived room id', async () => {
    const { raw, computer } = await pair()
    expect(computer.roomId).toBe(await deriveRoomId(raw))
  })

  test('computer -> glasses round trip', async () => {
    const { computer, glasses } = await pair()
    const frame = await computer.seal('reply', { text: 'All tests pass.' })
    const env = await glasses.open(frame)
    expect(env?.kind).toBe('reply')
    expect(env?.body).toEqual({ text: 'All tests pass.' })
  })

  test('glasses -> computer round trip', async () => {
    const { computer, glasses } = await pair()
    const env = await computer.open(await glasses.seal('verdict', { request_id: 'abcde', behavior: 'deny' }))
    expect(env?.body).toEqual({ request_id: 'abcde', behavior: 'deny' })
  })

  test('refuses to seal a kind the side may not send', async () => {
    const { computer, glasses } = await pair()
    await expect(computer.seal('verdict' as never, { request_id: 'abcde', behavior: 'allow' } as never)).rejects.toThrow()
    await expect(glasses.seal('permission' as never, {} as never)).rejects.toThrow()
  })

  test('drops a replayed frame', async () => {
    const { computer, glasses } = await pair()
    const frame = await glasses.seal('stop', {})
    expect(await computer.open(frame)).not.toBeNull()
    expect(await computer.open(frame)).toBeNull()
  })

  test('drops a stale command (older than 60 s)', async () => {
    const { raw, computer } = await pair()
    const key = await importKey(raw)
    const stale = { ...makeEnvelope('stop', {}), ts: Date.now() - 61_000 }
    const frame = await sealFrame(key, computer.roomId, 'g2c', enc.encode(JSON.stringify(stale)))
    expect(await computer.open(frame)).toBeNull()
  })

  test('accepts older display data for history replay', async () => {
    const { raw, glasses } = await pair()
    const key = await importKey(raw)
    const old = { ...makeEnvelope('reply', { text: 'earlier' }), ts: Date.now() - 10 * 60_000 }
    const frame = await sealFrame(key, glasses.roomId, 'c2g', enc.encode(JSON.stringify(old)))
    expect((await glasses.open(frame))?.body).toEqual({ text: 'earlier' })
  })

  test('drops frames from another key, garbage, and schema violations', async () => {
    const { computer } = await pair()
    const stranger = await SecureChannel.create(generateKey(), 'glasses')
    expect(await computer.open(await stranger.seal('stop', {}))).toBeNull()
    expect(await computer.open(new Uint8Array(40))).toBeNull()

    const { raw } = await pair()
    const c = await SecureChannel.create(raw, 'computer')
    const key = await importKey(raw)
    const bad = { ...makeEnvelope('verdict', { request_id: 'abcde', behavior: 'allow' }), body: { request_id: 'x', behavior: 'allow' } }
    expect(await c.open(await sealFrame(key, c.roomId, 'g2c', enc.encode(JSON.stringify(bad))))).toBeNull()
    expect(await c.open(await sealFrame(key, c.roomId, 'g2c', enc.encode('not json')))).toBeNull()
  })
})

describe('SecureChannel restart protection', () => {
  test('a restarted computer rejects commands sent before it started', async () => {
    const raw = generateKey()
    const glasses = await SecureChannel.create(raw, 'glasses')
    const key = await importKey(raw)
    const roomId = glasses.roomId
    // Captured 10 s ago, inside the 60 s window but before the channel restarted.
    const old = { ...makeEnvelope('verdict', { request_id: 'abcde', behavior: 'allow' }), ts: Date.now() - 10_000 }
    const frame = await sealFrame(key, roomId, 'g2c', enc.encode(JSON.stringify(old)))
    const restarted = await SecureChannel.create(raw, 'computer')
    expect(await restarted.open(frame)).toBeNull()
  })

  test('narrows body by kind', async () => {
    const raw = generateKey()
    const computer = await SecureChannel.create(raw, 'computer')
    const glasses = await SecureChannel.create(raw, 'glasses')
    const env = await computer.open(await glasses.seal('verdict', { request_id: 'abcde', behavior: 'allow' }))
    if (env?.kind !== 'verdict') throw new Error('expected verdict')
    const behavior: 'allow' | 'deny' = env.body.behavior
    expect(behavior).toBe('allow')
  })
})
