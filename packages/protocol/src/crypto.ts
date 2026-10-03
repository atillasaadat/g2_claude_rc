// End-to-end encryption between the channel and the glasses app.
//
// AES-256-GCM via WebCrypto, so there are no dependencies and the same code
// runs in Bun and in the phone WebView. The relay never holds the key.
//
// Frame layout: [version: 1 byte][nonce: 12 bytes][ciphertext + GCM tag]
// Additional data binds each frame to its room and direction, so the relay
// cannot move a frame to another room or reflect it back to its sender.

import { concat, toBase64Url, toHex } from './bytes'
import { FRAME_VERSION, KEY_BYTES, NONCE_BYTES } from './limits'

/** c2g: computer to glasses. g2c: glasses to computer. */
export type Direction = 'c2g' | 'g2c'

const enc = new TextEncoder()
const ROOM_LABEL = enc.encode('g2cc-room-v1')

export function generateKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES))
}

export async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) throw new Error(`key must be ${KEY_BYTES} bytes`)
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** Public room identifier: first 128 bits of SHA-256(label || key), as hex. */
export async function deriveRoomId(raw: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', concat(ROOM_LABEL, raw) as BufferSource)
  return toHex(new Uint8Array(digest).slice(0, 16))
}

function additionalData(roomId: string, dir: Direction): Uint8Array {
  return enc.encode(`g2cc/v${FRAME_VERSION}/${roomId}/${dir}`)
}

export async function sealFrame(
  key: CryptoKey,
  roomId: string,
  dir: Direction,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: additionalData(roomId, dir) as BufferSource },
    key,
    plaintext as BufferSource,
  )
  return concat(Uint8Array.of(FRAME_VERSION), nonce, new Uint8Array(ciphertext))
}

/** Throws on any failure. Callers must drop the frame without acting on it. */
export async function openFrame(
  key: CryptoKey,
  roomId: string,
  dir: Direction,
  frame: Uint8Array,
): Promise<Uint8Array> {
  if (frame.length < 1 + NONCE_BYTES + 16) throw new Error('frame too short')
  if (frame[0] !== FRAME_VERSION) throw new Error('unknown frame version')
  const nonce = frame.slice(1, 1 + NONCE_BYTES)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: additionalData(roomId, dir) as BufferSource },
    key,
    frame.slice(1 + NONCE_BYTES) as BufferSource,
  )
  return new Uint8Array(plaintext)
}

/**
 * Proof of key possession for joining a relay room. The relay stores a hash
 * of the first token it sees for a room and turns away anyone without it, so
 * knowing a room ID is not enough to evict peers or flood its history. It
 * reveals nothing about the key, and only gates the relay, not the messages.
 */
export async function relayAuthToken(raw: Uint8Array, roomId: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', k, enc.encode(`g2cc-relay-auth-v1/${roomId}`) as BufferSource)
  return toBase64Url(new Uint8Array(mac))
}
