// The glasses side of the encrypted relay link.

import { RelayClient, SecureChannel, type AnyEnvelope, type Body, type OutKind, type Pairing } from '@g2cc/protocol'
import type { Msg } from './state'

export class Link {
  private relay: RelayClient | null = null
  private secure: SecureChannel<'glasses'> | null = null

  constructor(private readonly dispatch: (msg: Msg) => void) {}

  async connect(pairing: Pairing): Promise<void> {
    this.disconnect()
    const secure = await SecureChannel.create(pairing.key, 'glasses')
    this.secure = secure
    const url = `${pairing.relayUrl.replace(/\/+$/, '')}/v1/room/${secure.roomId}?role=glasses`
    this.relay = new RelayClient({
      url,
      onStatus: status => this.dispatch({ type: 'relay', status }),
      onPresence: p => this.dispatch({ type: 'presence', computers: p.computer }),
      onFrame: async frame => {
        const env: AnyEnvelope | null = await secure.open(frame)
        // Frames that fail decryption, validation, or replay checks are dropped.
        if (env) this.dispatch({ type: 'envelope', env, now: Date.now() })
      },
    })
    this.relay.start()
  }

  /** Seals and sends a command. Buffered by the relay client while offline. */
  /** `sid` names the target session; several channels share the room. */
  async send<K extends OutKind<'glasses'>>(kind: K, body: Body<K>, sid: string): Promise<void> {
    if (!this.secure || !this.relay) throw new Error('not paired')
    this.relay.send(await this.secure.seal(kind, body, sid ? { sid } : {}))
  }

  disconnect(): void {
    this.relay?.stop()
    this.relay = null
    this.secure = null
    this.dispatch({ type: 'relay', status: 'closed' })
  }
}
