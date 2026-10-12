// The glasses side of the encrypted relay links: one per paired computer.
// Each computer has its own key and relay room, and the phone stays
// connected to all of them, so sessions from every computer show together.

import { RelayClient, relayAuthToken, relayRoomUrl, SecureChannel, type AnyEnvelope, type Body, type OutKind, type Pairing } from '@g2cc/protocol'
import type { Msg } from './state'

interface Room {
  pairing: Pairing
  relay: RelayClient
  secure: SecureChannel<'glasses'>
}

export class Links {
  private readonly rooms = new Map<string, Room>()

  constructor(private readonly dispatch: (msg: Msg) => void) {}

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
        if (env) this.dispatch({ type: 'envelope', env, now: Date.now(), room })
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
    for (const room of [...this.rooms.keys()]) this.close(room)
  }
}
