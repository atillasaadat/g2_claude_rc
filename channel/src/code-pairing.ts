// Pairing by short code (see packages/protocol/src/pair-code.ts): opens a
// one-off relay room for the code and hands the pairing to the phone that
// types it. Used by `pair.ts` and by the channel's `pair` tool.

import { ComputerPairing, newPairCode, PAIR_CODE_TTL_MS, RelayClient } from '@g2cc/protocol'
import { relaySocketUrl } from './config'
import { pairingText, type StoredPairing } from './pairing-store'

export interface OpenCodePairing {
  code: string
  expiresAt: number
  /** Resolves true once a phone stored the pairing, false when the code expired or was cancelled. */
  done: Promise<boolean>
  cancel(): void
}

export async function openCodePairing(
  pairing: StoredPairing,
  opts: { ttlMs?: number; code?: string } = {},
): Promise<OpenCodePairing> {
  const code = opts.code ?? newPairCode()
  const ttlMs = opts.ttlMs ?? PAIR_CODE_TTL_MS
  const session = await ComputerPairing.create(code, await pairingText(pairing))
  let finish: (ok: boolean) => void = () => {}
  const done = new Promise<boolean>(resolve => (finish = resolve))
  const relay: RelayClient = new RelayClient({
    url: relaySocketUrl(pairing.relayUrl, session.roomId, 'computer'),
    onFrame: async frame => {
      const r = await session.onFrame(frame)
      if (r.send) relay.send(r.send)
      if (r.done) end(true)
    },
  })
  const timer = setTimeout(() => end(false), ttlMs)
  let ended = false
  function end(ok: boolean): void {
    if (ended) return
    ended = true
    clearTimeout(timer)
    relay.stop()
    finish(ok)
  }
  // Buffered until the socket opens; the relay keeps it for a phone that joins later.
  relay.send(session.hello)
  relay.start()
  return { code, expiresAt: Date.now() + ttlMs, done, cancel: () => end(false) }
}
