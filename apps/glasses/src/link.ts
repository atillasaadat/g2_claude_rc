// The glasses side of the encrypted relay links: one per paired computer.
// Each computer has its own key and relay room, and the phone stays
// connected to all of them, so sessions from every computer show together.

import { RelayClient, relayAuthToken, relayRoomUrl, SecureChannel, type AnyEnvelope, type Body, type OutKind, type Pairing } from '@g2cc/protocol'
import type { Msg } from './state'

/**
 * Resends of a prompt that has no ack yet, in ms after the first send. Each
 * one also probes the link, so a connection that died without closing is
 * replaced within seconds instead of at the next keepalive.
 */
export const RESEND_AFTER_MS = [3_000, 7_000, 13_000, 22_000, 35_000] as const
/** Give up before the computer's 60 s replay window closes on the envelope. */
export const GIVE_UP_AFTER_MS = 50_000

interface Outgoing {
  sid: string
  text: string
  /** Envelope ids, one per room it went to (an unknown room means every room). */
  ids: string[]
  timers: ReturnType<typeof setTimeout>[]
}

interface Room {
  pairing: Pairing
  relay: RelayClient
  secure: SecureChannel<'glasses'>
}

export class Links {
  private readonly rooms = new Map<string, Room>()
  /** Prompts waiting for an ack, by envelope id. */
  private readonly outbox = new Map<string, Outgoing>()
  /** Sessions whose channel acks commands (it said so, or acked one). Older plugins never do. */
  private readonly ackers = new Set<string>()

  constructor(
    private readonly dispatch: (msg: Msg) => void,
    private readonly timing: { resendAfterMs: readonly number[]; giveUpAfterMs: number } = { resendAfterMs: RESEND_AFTER_MS, giveUpAfterMs: GIVE_UP_AFTER_MS },
  ) {}

  /** Connects to a paired computer, replacing any link to the same room. */
  async connect(pairing: Pairing): Promise<void> {
    const room = pairing.roomId
    this.close(room)
    const secure = await SecureChannel.create(pairing.key, 'glasses')
    const url = relayRoomUrl(pairing.relayUrl, secure.roomId, 'glasses', await relayAuthToken(pairing.key, secure.roomId))
    const relay = new RelayClient({
      url,
      onStatus: status => this.dispatch({ type: 'relay', status, room }),
      onPresence: p => this.dispatch({ type: 'presence', computers: p.computer, room }),
      onFrame: async frame => {
        const env: AnyEnvelope | null = await secure.open(frame)
        // Frames that fail decryption, validation, or replay checks are dropped.
        if (!env) return
        if (env.kind === 'ack') {
          this.onAck(env.sid ?? '', env.body.ids)
          return
        }
        this.dispatch({ type: 'envelope', env, now: Date.now(), room })
      },
    })
    this.rooms.set(room, { pairing, relay, secure })
    relay.start()
  }

  /**
   * Seals and sends a command to the session `sid` on the computer `room`.
   * Buffered by the relay client while offline. With no known room (an
   * envelope from an old channel without one) it goes to every computer; a
   * channel ignores commands for other sessions.
   */
  async send<K extends OutKind<'glasses'>>(kind: K, body: Body<K>, sid: string, room: string): Promise<void> {
    const target = this.rooms.get(room)
    const targets = target ? [target] : [...this.rooms.values()]
    if (!targets.length) throw new Error('not paired')
    for (const r of targets) r.relay.send(await r.secure.seal(kind, body, sid ? { sid } : {}))
  }

  /**
   * Sends a voice prompt and makes sure it arrives: resent (the same envelope,
   * so the channel acts on it once) until the channel acks it. Reports the
   * outcome as a `delivery` message; a session on an older plugin, which
   * never acks, gets no report either way.
   */
  async sendPrompt(text: string, sid: string, room: string): Promise<void> {
    const target = this.rooms.get(room)
    const links = target ? [target] : [...this.rooms.values()]
    if (!links.length) throw new Error('not paired')
    const sealed = await Promise.all(
      links.map(async link => ({ roomId: link.pairing.roomId, ...(await link.secure.sealWithId('prompt', { text }, sid ? { sid } : {})) })),
    )
    const push = (probe: boolean): void => {
      for (const { roomId, frame } of sealed) {
        // Looked up each time: a resync replaces the link (same room, same key), and a forgotten computer is skipped.
        const link = this.rooms.get(roomId)
        if (!link) continue
        link.relay.send(frame)
        if (probe) link.relay.probe()
      }
    }
    const out: Outgoing = { sid, text, ids: sealed.map(x => x.id), timers: [] }
    const { resendAfterMs, giveUpAfterMs } = this.timing
    out.timers = [...resendAfterMs.map(ms => setTimeout(() => push(true), ms)), setTimeout(() => this.giveUp(out), giveUpAfterMs)]
    for (const id of out.ids) this.outbox.set(id, out)
    push(false)
  }

  private onAck(sid: string, ids: readonly string[]): void {
    if (sid) this.ackers.add(sid)
    for (const id of ids) {
      const out = this.outbox.get(id)
      if (!out) continue
      this.settle(out)
      this.dispatch({ type: 'delivery', sid: out.sid, ok: true, text: out.text })
    }
  }

  private giveUp(out: Outgoing): void {
    if (!out.ids.some(id => this.outbox.get(id) === out)) return
    this.settle(out)
    if (this.ackers.has(out.sid)) this.dispatch({ type: 'delivery', sid: out.sid, ok: false, text: out.text })
  }

  private settle(out: Outgoing): void {
    for (const t of out.timers) clearTimeout(t)
    for (const id of out.ids) this.outbox.delete(id)
  }

  /** Checks every link now, e.g. when the app returns to the foreground. */
  probe(): void {
    for (const { relay } of this.rooms.values()) relay.probe()
  }

  /** Connects again: on every glasses connect, each channel announces its session. */
  async reconnect(): Promise<void> {
    for (const { pairing } of [...this.rooms.values()]) await this.connect(pairing)
  }

  /** Drops the link to one computer. */
  close(room: string): void {
    const r = this.rooms.get(room)
    if (!r) return
    r.relay.stop()
    this.rooms.delete(room)
    this.dispatch({ type: 'relay', status: 'closed', room })
  }

  closeAll(): void {
    for (const out of new Set(this.outbox.values())) this.settle(out)
    for (const room of [...this.rooms.keys()]) this.close(room)
  }
}
