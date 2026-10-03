// The glasses side of the encrypted relay link.

import { RelayClient, SecureChannel, type AnyEnvelope, type Pairing } from '@g2cc/protocol'
import type { Msg } from './state'

export class Link {
  private relay: RelayClient | null = null

  constructor(private readonly dispatch: (msg: Msg) => void) {}

  async connect(pairing: Pairing): Promise<void> {
    this.disconnect()
    const secure = await SecureChannel.create(pairing.key, 'glasses')
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

  disconnect(): void {
    this.relay?.stop()
    this.relay = null
    this.dispatch({ type: 'relay', status: 'closed' })
  }
}
