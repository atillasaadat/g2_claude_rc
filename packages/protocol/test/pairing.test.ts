import { describe, expect, test } from 'bun:test'
import { deriveRoomId, generateKey } from '../src/crypto'
import { decodePairing, encodePairing } from '../src/pairing'

describe('pairing payload', () => {
  test('round trips relay url, room id, and key', async () => {
    const key = generateKey()
    const text = await encodePairing({ relayUrl: 'wss://relay.example.workers.dev', key })
    const out = await decodePairing(text)
    expect(out.relayUrl).toBe('wss://relay.example.workers.dev')
    expect(out.key).toEqual(key)
    expect(out.roomId).toBe(await deriveRoomId(key))
  })

  test('rejects a room id that does not match the key', async () => {
    const text = await encodePairing({ relayUrl: 'wss://r.example', key: generateKey() })
    const obj = JSON.parse(text)
    obj.roomId = 'a'.repeat(32)
    await expect(decodePairing(JSON.stringify(obj))).rejects.toThrow()
  })

  test('requires wss, except ws on localhost for development', async () => {
    const key = generateKey()
    await expect(encodePairing({ relayUrl: 'ws://relay.example', key })).rejects.toThrow()
    await expect(encodePairing({ relayUrl: 'https://relay.example', key })).rejects.toThrow()
    expect(await encodePairing({ relayUrl: 'ws://127.0.0.1:8787', key })).toContain('127.0.0.1')
    expect(await encodePairing({ relayUrl: 'ws://localhost:8787', key })).toContain('localhost')
  })

  test('rejects garbage', async () => {
    await expect(decodePairing('not json')).rejects.toThrow()
    await expect(decodePairing('{"v":1}')).rejects.toThrow()
  })
})
