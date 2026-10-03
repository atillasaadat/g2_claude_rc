// Pairing payload the channel hands to the phone app, by code (pair-code.ts) or pasted.

import { z } from 'zod'
import { fromBase64Url, toBase64Url } from './bytes'
import { deriveRoomId } from './crypto'
import { KEY_BYTES } from './limits'

export interface Pairing {
  relayUrl: string
  roomId: string
  key: Uint8Array
  /** Optional Groq API key for voice prompts, so the public app bundle never contains one. */
  sttKey?: string
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
  sttKey: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/).optional(),
})

export async function encodePairing(input: { relayUrl: string; key: Uint8Array; sttKey?: string }): Promise<string> {
  assertRelayUrl(input.relayUrl)
  if (input.key.length !== KEY_BYTES) throw new Error('bad key length')
  const roomId = await deriveRoomId(input.key)
  const payload = { v: 1, relayUrl: input.relayUrl, roomId, key: toBase64Url(input.key), ...(input.sttKey ? { sttKey: input.sttKey } : {}) }
  return JSON.stringify(wire.parse(payload))
}

export async function decodePairing(text: string): Promise<Pairing> {
  const p = wire.parse(JSON.parse(text))
  assertRelayUrl(p.relayUrl)
  const key = fromBase64Url(p.key)
  if (key.length !== KEY_BYTES) throw new Error('bad key length')
  if ((await deriveRoomId(key)) !== p.roomId) throw new Error('room id does not match key')
  return { relayUrl: p.relayUrl, roomId: p.roomId, key, ...(p.sttKey ? { sttKey: p.sttKey } : {}) }
}
