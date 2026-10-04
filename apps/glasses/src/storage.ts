// Persistent settings in SDK local storage (shared BLE link, so through the queue).

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { decodePairing, type Pairing } from '@g2cc/protocol'
import type { BridgeQueue } from './bridge-queue'
import { DEFAULT_GESTURES, parseGestureMap, type GestureMap } from './gestures'

const PAIRING_KEY = 'g2cc.pairing'
const GESTURES_KEY = 'g2cc.gestures'
const STT_KEY = 'g2cc.sttKey'
const DISPLAY_SLEEP_KEY = 'g2cc.displaySleep'

/** Display sleep choices in seconds; 0 keeps the display on. */
export const DISPLAY_SLEEP_CHOICES = [0, 5, 10, 15, 30, 60, 120, 300] as const
export const STT_KEY_SHAPE = /^[A-Za-z0-9_-]{8,200}$/

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
    if (pairing.sttKey) await this.saveSttKey(pairing.sttKey)
    return pairing
  }

  /** The Groq key for voice prompts (from the pairing or typed in the phone UI). */
  async loadSttKey(): Promise<string> {
    const key = (await this.get(STT_KEY)).trim()
    return STT_KEY_SHAPE.test(key) ? key : ''
  }

  async saveSttKey(key: string): Promise<void> {
    const k = key.trim()
    if (k && !STT_KEY_SHAPE.test(k)) throw new Error('that does not look like a Groq API key')
    await this.set(STT_KEY, k)
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

  /** Seconds before the display turns off while Claude works; 0 (the default) keeps it on. */
  async loadDisplaySleep(): Promise<number> {
    const n = Number(await this.get(DISPLAY_SLEEP_KEY))
    return (DISPLAY_SLEEP_CHOICES as readonly number[]).includes(n) ? n : 0
  }

  async saveDisplaySleep(seconds: number): Promise<void> {
    if (!(DISPLAY_SLEEP_CHOICES as readonly number[]).includes(seconds)) throw new Error('not a display sleep choice')
    await this.set(DISPLAY_SLEEP_KEY, String(seconds))
  }
}
