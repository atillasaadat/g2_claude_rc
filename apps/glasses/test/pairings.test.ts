// Several paired computers in SDK local storage.
import { describe, expect, test } from 'bun:test'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { encodePairing, generateKey } from '@g2cc/protocol'
import { BridgeQueue } from '../src/bridge-queue'
import { MAX_PAIRINGS, Storage } from '../src/storage'

function storage(initial: Record<string, string> = {}): { store: Storage; data: Record<string, string> } {
  const data = { ...initial }
  const bridge = {
    getLocalStorage: async (k: string) => data[k] ?? '',
    setLocalStorage: async (k: string, v: string) => ((data[k] = v), true),
  } as unknown as EvenAppBridge
  return { store: new Storage(bridge, new BridgeQueue()), data }
}
const pairingText = (): Promise<string> => encodePairing({ relayUrl: 'wss://relay.example', key: generateKey() })

describe('paired computers', () => {
  test('pairing a second computer adds it instead of replacing the first', async () => {
    const { store } = storage()
    const a = await store.addPairing(await pairingText(), 1)
    const b = await store.addPairing(await pairingText(), 2)
    expect((await store.loadPairings()).map(p => p.pairing.roomId)).toEqual([a.roomId, b.roomId])
  })

  test('pairing the same computer again refreshes it, without a duplicate', async () => {
    const { store } = storage()
    const text = await pairingText()
    await store.addPairing(text, 1)
    const b = await store.addPairing(await pairingText(), 2)
    await store.addPairing(text, 3)
    const list = await store.loadPairings()
    expect(list.length).toBe(2)
    expect(list[0]!.pairing.roomId).toBe(b.roomId)
    expect(list[1]!.addedAt).toBe(3)
  })

  test('forgetting one computer keeps the others', async () => {
    const { store } = storage()
    const a = await store.addPairing(await pairingText(), 1)
    const b = await store.addPairing(await pairingText(), 2)
    await store.removePairing(a.roomId)
    expect((await store.loadPairings()).map(p => p.pairing.roomId)).toEqual([b.roomId])
    await store.forgetPairings()
    expect(await store.loadPairings()).toEqual([])
  })

  test(`keeps at most ${MAX_PAIRINGS}; the oldest goes`, async () => {
    const { store } = storage()
    const first = await store.addPairing(await pairingText(), 0)
    for (let i = 1; i <= MAX_PAIRINGS; i++) await store.addPairing(await pairingText(), i)
    const list = await store.loadPairings()
    expect(list.length).toBe(MAX_PAIRINGS)
    expect(list.some(p => p.pairing.roomId === first.roomId)).toBe(false)
  })

  test('a pairing saved by the one-computer version moves into the list', async () => {
    const legacy = await pairingText()
    const { store, data } = storage({ 'g2cc.pairing': legacy })
    const list = await store.loadPairings()
    expect(list.map(p => p.text)).toEqual([legacy])
    expect(data['g2cc.pairing']).toBe('')
    // Pairing another computer keeps it.
    await store.addPairing(await pairingText(), 5)
    expect((await store.loadPairings()).length).toBe(2)
  })

  test('damaged entries are skipped, and a bad paste changes nothing', async () => {
    const good = await pairingText()
    const { store } = storage({ 'g2cc.pairings': JSON.stringify([{ text: '{nope', addedAt: 1 }, { text: good, addedAt: 2 }, 'junk']) })
    expect((await store.loadPairings()).map(p => p.text)).toEqual([good])
    await expect(store.addPairing('not a pairing')).rejects.toThrow()
    expect((await store.loadPairings()).length).toBe(1)
  })
})
