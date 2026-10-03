// Pairing by short code: the channel shows an 8-character code, the user
// types it into the phone app, and the two exchange the pairing over the relay.
//
// The code is split in two. The first 3 characters pick a public rendezvous
// room on the relay (15 bits, only there so the two sides find each other).
// The last 5 characters (25 bits) are a password for CPace, a balanced PAKE
// over ristretto255: the shared generator is derived from the password, so
// the messages give nothing to test guesses against offline. Someone in the
// middle, the relay included, gets one online guess per attempt, and the
// channel gives up after MAX_ATTEMPTS failed attempts, so the odds of a
// successful guess are about 3 in 33 million per code.
//
//   computer -> phone     hello    {sid, Y: yC * G}               G = H2C(sid, password)
//   phone    -> computer  join     {sid, Y: yP * G, mac: HMAC(k, "phone"  transcript)}
//   computer -> phone     pairing  {sid, iv, ct: AES-GCM(k, pairing text, transcript)}
//   phone    -> computer  done     {sid, mac: HMAC(k, "done" transcript)}
//
// k comes from the shared point yC * yP * G and the transcript (sid, both Ys).
// The pairing frame doubles as the channel's key confirmation: only a party
// that derived k can seal it.

import { z } from 'zod'
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js'
import { concat, fromBase64Url, toBase64Url, toHex } from './bytes'

/** Crockford base32: no I, L, O or U, so the code reads unambiguously. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const PAIR_CODE_CHARS = 8
const RENDEZVOUS_CHARS = 3
/** How long a code stays open. */
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000
/** Failed attempts (wrong password) a code survives before the channel closes it. */
export const MAX_ATTEMPTS = 3

const enc = new TextEncoder()
const dec = new TextDecoder()
const Point = ristretto255.Point
type RPoint = InstanceType<typeof Point>

/** A fresh code, formatted for reading aloud: "ABCD-EFGH". */
export function newPairCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIR_CODE_CHARS))
  const chars = Array.from(bytes, b => ALPHABET[b & 31] as string).join('')
  return `${chars.slice(0, 4)}-${chars.slice(4)}`
}

/** Canonical form of what the user typed, or null if it cannot be a code. */
export function normalizePairCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (s.length !== PAIR_CODE_CHARS) return null
  for (const c of s) if (!ALPHABET.includes(c)) return null
  return s
}

function split(code: string): { rendezvous: string; password: string } {
  const norm = normalizePairCode(code)
  if (!norm) throw new Error('not a pairing code')
  return { rendezvous: norm.slice(0, RENDEZVOUS_CHARS), password: norm.slice(RENDEZVOUS_CHARS) }
}

/** The public rendezvous room for a code: depends only on its first 3 characters. */
export async function pairRoomId(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`g2cc-pair-room-v2/${split(code).rendezvous}`) as BufferSource)
  return toHex(new Uint8Array(digest).slice(0, 16))
}

const generator = (sid: Uint8Array, password: string): RPoint =>
  ristretto255_hasher.hashToCurve(concat(enc.encode('g2cc-cpace-v2/'), sid, enc.encode(`/${password}`)), {
    DST: 'g2cc-cpace-v2-ristretto255',
  }) as RPoint

const randomScalar = (): bigint => {
  const s = ristretto255_hasher.hashToScalar(crypto.getRandomValues(new Uint8Array(64)), { DST: 'g2cc-cpace-v2-scalar' })
  return s === 0n ? 1n : s
}

function decodePoint(b64: string): RPoint | null {
  try {
    const p = Point.fromBytes(fromBase64Url(b64))
    return p.is0() ? null : p
  } catch {
    return null
  }
}

interface Keys {
  aes: CryptoKey
  mac: CryptoKey
  transcript: Uint8Array
}

async function deriveKeys(shared: RPoint, sid: Uint8Array, yC: Uint8Array, yP: Uint8Array): Promise<Keys> {
  const transcript = concat(enc.encode('g2cc-cpace-v2'), sid, yC, yP)
  const ikm = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(transcript, shared.toBytes()) as BufferSource))
  const base = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveKey'])
  const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32) as BufferSource, info: enc.encode(info) as BufferSource })
  const aes = await crypto.subtle.deriveKey(hkdf('g2cc-pair-aes'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const mac = await crypto.subtle.deriveKey(hkdf('g2cc-pair-mac'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify'])
  return { aes, mac, transcript }
}

const sign = async (k: Keys, label: string): Promise<string> =>
  toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', k.mac, concat(enc.encode(label), k.transcript) as BufferSource)))

const verify = async (k: Keys, label: string, mac: string): Promise<boolean> => {
  try {
    return await crypto.subtle.verify('HMAC', k.mac, fromBase64Url(mac) as BufferSource, concat(enc.encode(label), k.transcript) as BufferSource)
  } catch {
    return false
  }
}

const b64 = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)
const Msg = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('hello'), sid: b64, y: b64 }),
  z.strictObject({ t: z.literal('join'), sid: b64, y: b64, mac: b64 }),
  z.strictObject({ t: z.literal('pairing'), sid: b64, iv: b64, ct: z.string().regex(/^[A-Za-z0-9_-]{1,8000}$/) }),
  z.strictObject({ t: z.literal('done'), sid: b64, mac: b64 }),
])
type Msg = z.infer<typeof Msg>

const frame = (m: Msg): Uint8Array => enc.encode(JSON.stringify(m))
function parse(f: Uint8Array): Msg | null {
  try {
    const r = Msg.safeParse(JSON.parse(dec.decode(f)))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

export type ComputerResult = { send?: Uint8Array; done?: true; failed?: true }

/** The channel's side. Send `hello` once connected, then feed it every frame. */
export class ComputerPairing {
  private keys: Keys | null = null
  private attempts = 0
  private closed = false
  /** Frames are handled one at a time, so two joins can never both be accepted. */
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    readonly roomId: string,
    readonly hello: Uint8Array,
    private readonly sid: string,
    private readonly sidBytes: Uint8Array,
    private readonly y: bigint,
    private readonly yBytes: Uint8Array,
    private readonly pairingText: string,
  ) {}

  static async create(code: string, pairingText: string): Promise<ComputerPairing> {
    const { password } = split(code)
    const sidBytes = crypto.getRandomValues(new Uint8Array(16))
    const sid = toBase64Url(sidBytes)
    const y = randomScalar()
    const yBytes = generator(sidBytes, password).multiply(y).toBytes()
    const hello = frame({ t: 'hello', sid, y: toBase64Url(yBytes) })
    return new ComputerPairing(await pairRoomId(code), hello, sid, sidBytes, y, yBytes, pairingText)
  }

  /**
   * `done`: the phone stored the pairing. `failed`: too many wrong attempts,
   * the code is closed. Anything that fails a check is otherwise ignored.
   */
  onFrame(f: Uint8Array): Promise<ComputerResult> {
    const next = this.queue.then(() => this.handle(f))
    this.queue = next.catch(() => {})
    return next
  }

  private async handle(f: Uint8Array): Promise<ComputerResult> {
    if (this.closed) return {}
    const m = parse(f)
    if (!m || m.sid !== this.sid) return {}
    if (m.t === 'join' && !this.keys) {
      const peer = decodePoint(m.y)
      if (!peer) return {}
      const keys = await deriveKeys(peer.multiply(this.y), this.sidBytes, this.yBytes, fromBase64Url(m.y))
      if (!(await verify(keys, 'phone', m.mac))) {
        this.attempts += 1
        if (this.attempts < MAX_ATTEMPTS) return {}
        this.closed = true
        return { failed: true }
      }
      this.keys = keys
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ct = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: keys.transcript as BufferSource },
          keys.aes,
          enc.encode(this.pairingText) as BufferSource,
        ),
      )
      return { send: frame({ t: 'pairing', sid: this.sid, iv: toBase64Url(iv), ct: toBase64Url(ct) }) }
    }
    if (m.t === 'done' && this.keys && (await verify(this.keys, 'done', m.mac))) {
      this.closed = true
      return { done: true }
    }
    return {}
  }
}

/**
 * The phone's side. Feed it every frame. It answers every hello in the room
 * (another computer may share the rendezvous room), and returns the pairing
 * text from the one whose key confirmation checks out.
 */
export class GlassesPairing {
  private readonly sessions = new Map<string, Keys>()
  private finished = false

  private constructor(
    readonly roomId: string,
    private readonly password: string,
  ) {}

  static async create(code: string): Promise<GlassesPairing> {
    return new GlassesPairing(await pairRoomId(code), split(code).password)
  }

  async onFrame(f: Uint8Array): Promise<{ send?: Uint8Array; pairingText?: string }> {
    if (this.finished) return {}
    const m = parse(f)
    if (m?.t === 'hello' && !this.sessions.has(m.sid)) {
      const peer = decodePoint(m.y)
      if (!peer) return {}
      const sidBytes = fromBase64Url(m.sid)
      const y = randomScalar()
      const yBytes = generator(sidBytes, this.password).multiply(y).toBytes()
      const keys = await deriveKeys(peer.multiply(y), sidBytes, fromBase64Url(m.y), yBytes)
      this.sessions.set(m.sid, keys)
      return { send: frame({ t: 'join', sid: m.sid, y: toBase64Url(yBytes), mac: await sign(keys, 'phone') }) }
    }
    if (m?.t === 'pairing') {
      const keys = this.sessions.get(m.sid)
      if (!keys) return {}
      try {
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64Url(m.iv) as BufferSource, additionalData: keys.transcript as BufferSource },
          keys.aes,
          fromBase64Url(m.ct) as BufferSource,
        )
        this.finished = true
        return { pairingText: dec.decode(pt), send: frame({ t: 'done', sid: m.sid, mac: await sign(keys, 'done') }) }
      } catch {
        return {}
      }
    }
    return {}
  }
}
