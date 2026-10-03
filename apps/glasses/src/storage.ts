// Persistent settings in SDK local storage (shared BLE link, so through the queue).

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { decodePairing, type Pairing } from '@g2cc/protocol'
import type { BridgeQueue } from './bridge-queue'
import { DEFAULT_GESTURES, parseGestureMap, type GestureMap } from './gestures'

const PAIRING_KEY = 'g2cc.pairing'
const GESTURES_KEY = 'g2cc.gestures'

export class Storage {
  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly queue: BridgeQueue,
  ) {}

  private get(key: string): Promise<string> {
    return this.queue.run(`getLocalStorage ${key}`, () => this.bridge.getLocalStorage(key)).then(v => v ?? '')
  }

  private async set(key: string, value: string): Promise<void> {
    const ok = await this.queue.run(`setLocalStorage ${key}`, () => this.bridge.setLocalStorage(key, value))
    if (!ok) throw new Error(`could not save ${key}`)
  }

  /** The stored pairing, or null if none or it no longer validates. */
  async loadPairing(): Promise<{ text: string; pairing: Pairing } | null> {
    const text = await this.get(PAIRING_KEY)
    if (!text) return null
    try {
      return { text, pairing: await decodePairing(text) }
    } catch {
      return null
    }
  }

  /** Validates before saving, so a bad paste never replaces a good pairing. */
  async savePairing(text: string): Promise<Pairing> {
    const pairing = await decodePairing(text.trim())
    await this.set(PAIRING_KEY, text.trim())
    return pairing
  }

  async forgetPairing(): Promise<void> {
    await this.set(PAIRING_KEY, '')
  }

  async loadGestures(): Promise<GestureMap> {
    const raw = await this.get(GESTURES_KEY)
    return raw ? parseGestureMap(raw) : DEFAULT_GESTURES
  }

  async saveGestures(map: GestureMap): Promise<void> {
    await this.set(GESTURES_KEY, JSON.stringify(map))
  }
}
