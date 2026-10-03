// The pairing secret lives in ~/.g2cc/pairing.json, owner-only. Whoever holds
// this key can approve tool use through the glasses, so treat it like a password.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { encodePairing, fromBase64Url, generateKey, KEY_BYTES, toBase64Url } from '@g2cc/protocol'

export interface StoredPairing {
  relayUrl: string
  key: Uint8Array
}

const fileSchema = z.strictObject({ v: z.literal(1), relayUrl: z.string(), key: z.string() })

export function pairingPath(home: string): string {
  return join(home, 'pairing.json')
}

function read(home: string): StoredPairing | null {
  const path = pairingPath(home)
  if (!existsSync(path)) return null
  // A corrupt file is an error, not a reason to mint a new key: re-keying
  // silently would unpair the glasses without telling anyone.
  const f = fileSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  const key = fromBase64Url(f.key)
  if (key.length !== KEY_BYTES) throw new Error(`${path}: bad key length`)
  return { relayUrl: f.relayUrl, key }
}

function write(home: string, p: StoredPairing): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  chmodSync(home, 0o700)
  const path = pairingPath(home)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ v: 1, relayUrl: p.relayUrl, key: toBase64Url(p.key) }, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
}

/**
 * Loads the pairing, creating a key on first use. `relayUrl` updates the stored
 * relay (validated by encodePairing). `rotate` mints a new key, unpairing the glasses.
 */
export async function loadOrCreatePairing(
  home: string,
  opts: { relayUrl?: string; rotate?: boolean } = {},
): Promise<StoredPairing> {
  const existing = read(home)
  const relayUrl = opts.relayUrl ?? existing?.relayUrl
  if (!relayUrl) throw new Error('no relay URL configured: run `bun channel/pair.ts --relay <url>`')
  const key = opts.rotate || !existing ? generateKey() : existing.key
  const next = { relayUrl, key }
  await encodePairing(next) // validates the URL before anything is written
  if (!existing || opts.rotate || existing.relayUrl !== relayUrl) write(home, next)
  return next
}

/** The text the glasses app pastes or scans. Contains the key. */
export function pairingText(p: StoredPairing): Promise<string> {
  return encodePairing(p)
}
