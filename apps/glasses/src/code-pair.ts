// The phone side of pairing by code (packages/protocol/src/pair-code.ts):
// joins the code's one-off relay room and returns the pairing text.

import { GlassesPairing, normalizePairCode, RelayClient, relayPairUrl } from '@g2cc/protocol'

/** The hosted relay. A dev build can point elsewhere with VITE_G2CC_RELAY_URL. */
export const DEFAULT_RELAY_URL: string =
  (import.meta.env?.VITE_G2CC_RELAY_URL as string | undefined) || 'wss://atillasaadat.com/g2-claude'

const WAIT_MS = 30_000

/** `relayUrl` is only for self-hosted relays; it must be wss:// (ws:// only for localhost). */
export async function pairWithCode(input: string, relayUrl = DEFAULT_RELAY_URL): Promise<string> {
  if (!normalizePairCode(input)) throw new Error('a code has 8 letters and digits, like ABCD-EFGH')
  const u = new URL(relayUrl)
  if (!(u.protocol === 'wss:' || (u.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(u.hostname)))) {
    throw new Error('the relay address must start with wss://')
  }
  const session = await GlassesPairing.create(input)
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      relay.stop()
      reject(new Error('no answer for that code. Check it, or ask for a new one with /g2:pair'))
    }, WAIT_MS)
    const relay: RelayClient = new RelayClient({
      url: relayPairUrl(relayUrl, session.roomId, 'glasses'),
      onFrame: async frame => {
        const r = await session.onFrame(frame)
        if (r.send) relay.send(r.send)
        if (r.pairingText) {
          clearTimeout(timer)
          // Let the "done" frame reach the computer before closing.
          setTimeout(() => relay.stop(), 500)
          resolve(r.pairingText)
        }
      },
    })
    relay.start()
  })
}
