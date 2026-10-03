// Pairing payload shown as a QR code by the channel and scanned by the glasses app.

import { z } from 'zod'
import { fromBase64Url, toBase64Url } from './bytes'
import { deriveRoomId } from './crypto'
import { KEY_BYTES } from './limits'

export interface Pairing {
  relayUrl: string
  roomId: string
  key: Uint8Array
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function assertRelayUrl(raw: string): void {
  const url = new URL(raw)
  const ok = url.protocol === 'wss:' || (url.protocol === 'ws:' && LOCAL_HOSTS.has(url.hostname))
  if (!ok) throw new Error('relay URL must be wss:// (ws:// only for localhost)')
}

const wire = z.strictObject({
  v: z.literal(1),
  relayUrl: z.string().max(500),
  roomId: z.string().regex(/^[0-9a-f]{32}$/),
  key: z.string(),
})

export async function encodePairing(input: { relayUrl: string; key: Uint8Array }): Promise<string> {
  assertRelayUrl(input.relayUrl)
  if (input.key.length !== KEY_BYTES) throw new Error('bad key length')
  const roomId = await deriveRoomId(input.key)
  return JSON.stringify({ v: 1, relayUrl: input.relayUrl, roomId, key: toBase64Url(input.key) })
}

export async function decodePairing(text: string): Promise<Pairing> {
  const p = wire.parse(JSON.parse(text))
  assertRelayUrl(p.relayUrl)
  const key = fromBase64Url(p.key)
  if (key.length !== KEY_BYTES) throw new Error('bad key length')
  if ((await deriveRoomId(key)) !== p.roomId) throw new Error('room id does not match key')
  return { relayUrl: p.relayUrl, roomId: p.roomId, key }
}
