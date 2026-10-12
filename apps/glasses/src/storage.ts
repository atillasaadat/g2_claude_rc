// Persistent settings in SDK local storage (shared BLE link, so through the queue).

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { decodePairing, type Pairing } from '@g2cc/protocol'
import type { BridgeQueue } from './bridge-queue'
import { DEFAULT_GESTURES, parseGestureMap, type GestureMap } from './gestures'
import { MAX_MUTED, type MutedSession } from './state'

/** Before several computers: one pairing text. Read once and moved into PAIRINGS_KEY. */
const LEGACY_PAIRING_KEY = 'g2cc.pairing'
const PAIRINGS_KEY = 'g2cc.pairings'
const GESTURES_KEY = 'g2cc.gestures'
const STT_KEY = 'g2cc.sttKey'
const DISPLAY_SLEEP_KEY = 'g2cc.displaySleep'
const MUTED_KEY = 'g2cc.mutedSessions'

/** Display sleep choices in seconds; 0 keeps the display on. */
export const DISPLAY_SLEEP_CHOICES = [0, 5, 10, 15, 30, 60, 120, 300] as const
export const STT_KEY_SHAPE = /^[A-Za-z0-9_-]{8,200}$/
/** Paired computers kept at most; pairing one more drops the oldest. */
export const MAX_PAIRINGS = 8

/** A paired computer as stored: the pairing text and when it was paired (ms). */
export interface StoredPairing {
  text: string
  pairing: Pairing
  addedAt: number
}

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

  /**
   * Every paired computer, oldest first. Entries that no longer validate are
   * skipped. A pairing saved by an older version (one computer) moves in here.
   */
  async loadPairings(): Promise<StoredPairing[]> {
    let raw: unknown
    try {
      raw = JSON.parse((await this.get(PAIRINGS_KEY)) || '[]')
    } catch {
      raw = []
    }
    const entries = Array.isArray(raw) ? raw : []
    const out: StoredPairing[] = []
    for (const e of entries) {
      if (typeof e?.text !== 'string' || typeof e?.addedAt !== 'number') continue
      try {
        const pairing = await decodePairing(e.text)
        if (!out.some(p => p.pairing.roomId === pairing.roomId)) out.push({ text: e.text, pairing, addedAt: e.addedAt })
      } catch {
        // A damaged entry is dropped on the next save.
      }
    }
    const legacy = await this.get(LEGACY_PAIRING_KEY)
    if (legacy) {
      try {
        const pairing = await decodePairing(legacy)
        if (!out.some(p => p.pairing.roomId === pairing.roomId)) out.unshift({ text: legacy, pairing, addedAt: 0 })
        await this.writePairings(out)
      } catch {
        // Unreadable: nothing to move.
      }
      await this.set(LEGACY_PAIRING_KEY, '')
    }
    return out.slice(-MAX_PAIRINGS)
  }

  private async writePairings(list: readonly StoredPairing[]): Promise<void> {
    await this.set(PAIRINGS_KEY, JSON.stringify(list.slice(-MAX_PAIRINGS).map(p => ({ text: p.text, addedAt: p.addedAt }))))
  }

  /**
   * Adds a computer, or refreshes it if this phone already pairs with it (same
   * room). Validates before saving, so a bad paste never touches the list.
   */
  async addPairing(text: string, now = Date.now()): Promise<Pairing> {
    const pairing = await decodePairing(text.trim())
    const others = (await this.loadPairings()).filter(p => p.pairing.roomId !== pairing.roomId)
    await this.writePairings([...others, { text: text.trim(), pairing, addedAt: now }])
    if (pairing.sttKey) await this.saveSttKey(pairing.sttKey)
    return pairing
  }

  /** Forgets one computer. */
  async removePairing(roomId: string): Promise<void> {
    await this.writePairings((await this.loadPairings()).filter(p => p.pairing.roomId !== roomId))
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

  /** Forgets every computer. */
  async forgetPairings(): Promise<void> {
    await this.set(PAIRINGS_KEY, '')
    await this.set(LEGACY_PAIRING_KEY, '')
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

  /** Sessions disconnected in the phone view. Anything unreadable counts as none. */
  async loadMuted(): Promise<MutedSession[]> {
    try {
      const raw: unknown = JSON.parse((await this.get(MUTED_KEY)) || '[]')
      if (!Array.isArray(raw)) return []
      return raw
        .filter((m): m is MutedSession => typeof m?.sid === 'string' && typeof m?.name === 'string' && m.sid.length <= 64)
        .map(m => ({ sid: m.sid, name: m.name.slice(0, 80) }))
        .slice(-MAX_MUTED)
    } catch {
      return []
    }
  }

  async saveMuted(sessions: readonly MutedSession[]): Promise<void> {
    await this.set(MUTED_KEY, JSON.stringify(sessions.slice(-MAX_MUTED)))
  }

  async saveDisplaySleep(seconds: number): Promise<void> {
    if (!(DISPLAY_SLEEP_CHOICES as readonly number[]).includes(seconds)) throw new Error('not a display sleep choice')
    await this.set(DISPLAY_SLEEP_KEY, String(seconds))
  }
}
