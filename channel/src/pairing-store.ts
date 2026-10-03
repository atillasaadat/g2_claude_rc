// The pairing secret lives in ~/.g2cc/pairing.json, owner-only. Whoever holds
// this key can approve tool use through the glasses, so treat it like a password.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { encodePairing, fromBase64Url, generateKey, KEY_BYTES, toBase64Url } from '@g2cc/protocol'

export interface StoredPairing {
  relayUrl: string
  key: Uint8Array
  /** Groq key handed to the glasses inside the pairing, never baked into the app. */
  sttKey?: string
}

const fileSchema = z.strictObject({ v: z.literal(1), relayUrl: z.string(), key: z.string(), sttKey: z.string().optional() })

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
  return { relayUrl: f.relayUrl, key, ...(f.sttKey ? { sttKey: f.sttKey } : {}) }
}

function write(home: string, p: StoredPairing): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  chmodSync(home, 0o700)
  const path = pairingPath(home)
  const tmp = `${path}.tmp`
  const body = { v: 1, relayUrl: p.relayUrl, key: toBase64Url(p.key), ...(p.sttKey ? { sttKey: p.sttKey } : {}) }
  writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
}

/**
 * Loads the pairing, creating a key on first use. `relayUrl` updates the stored
 * relay (validated by encodePairing). `rotate` mints a new key, unpairing the glasses.
 */
export async function loadOrCreatePairing(
  home: string,
  opts: { relayUrl?: string; rotate?: boolean; sttKey?: string } = {},
): Promise<StoredPairing> {
  const existing = read(home)
  const relayUrl = opts.relayUrl ?? existing?.relayUrl
  if (!relayUrl) throw new Error('no relay URL configured: run `bun channel/pair.ts --relay <url>`')
  const key = opts.rotate || !existing ? generateKey() : existing.key
  const sttKey = opts.sttKey ?? existing?.sttKey
  const next: StoredPairing = { relayUrl, key, ...(sttKey ? { sttKey } : {}) }
  await encodePairing(next) // validates the URL and key before anything is written
  if (!existing || opts.rotate || existing.relayUrl !== relayUrl || existing.sttKey !== sttKey) write(home, next)
  return next
}

/**
 * Where the glasses app is served for a deployed relay: the relay URL
 * wss://host/prefix maps to https://host/prefix/app/. Null for a local relay.
 */
export function appUrlFor(relayUrl: string): string | null {
  const u = new URL(relayUrl)
  if (u.protocol !== 'wss:') return null
  return `https://${u.host}${u.pathname.replace(/\/+$/, '')}/app/`
}

/** The text the glasses app pastes or scans. Contains the key. */
export function pairingText(p: StoredPairing): Promise<string> {
  return encodePairing(p)
}
