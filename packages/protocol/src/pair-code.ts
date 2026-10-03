// Pairing by short code: the channel shows an 8-character code, the user
// types it into the phone app, and the two exchange the pairing over the relay.
//
// The code alone never carries the key. Both sides run an ECDH exchange in a
// one-off relay room, and each side authenticates its public key with an HMAC
// keyed by the code. The pairing text then travels sealed under the ECDH
// secret. So someone who only sees the relay traffic learns nothing, and
// someone who only sees the code cannot recover the key afterwards. To get in
// the middle you would need the code and an active relay position while the
// pairing is open. The room ID and HMAC key come from PBKDF2 of the code, so
// guessing the code from relay traffic costs PBKDF2 work per guess.
//
//   computer -> glasses  hello    {pk, mac = HMAC(k, "c|" pk)}
//   glasses  -> computer join     {pk, mac = HMAC(k, "g|" pkC "|" pkG)}
//   computer -> glasses  pairing  {iv, ct = AES-GCM(ecdh, pairing text)}
//   glasses  -> computer done     {mac = HMAC(k, "d|" pkG)}

import { z } from 'zod'
import { concat, fromBase64Url, toBase64Url, toHex } from './bytes'

/** Crockford base32: no I, L, O or U, so the code reads unambiguously. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const PAIR_CODE_CHARS = 8
/** How long a code stays open. */
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000
const PBKDF2_ITERATIONS = 200_000

const enc = new TextEncoder()
const dec = new TextDecoder()

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

interface CodeSecrets {
  roomId: string
  mac: CryptoKey
  salt: Uint8Array
}

async function codeSecrets(code: string): Promise<CodeSecrets> {
  const norm = normalizePairCode(code)
  if (!norm) throw new Error('not a pairing code')
  const base = await crypto.subtle.importKey('raw', enc.encode(norm) as BufferSource, 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('g2cc-pair-v1') as BufferSource, iterations: PBKDF2_ITERATIONS },
      base,
      48 * 8,
    ),
  )
  const salt = bits.slice(0, 32)
  const mac = await crypto.subtle.importKey('raw', salt as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
  return { roomId: toHex(bits.slice(32, 48)), mac, salt }
}

const sign = async (key: CryptoKey, label: string): Promise<string> =>
  toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(label) as BufferSource)))

const verify = async (key: CryptoKey, label: string, mac: string): Promise<boolean> => {
  try {
    return await crypto.subtle.verify('HMAC', key, fromBase64Url(mac) as BufferSource, enc.encode(label) as BufferSource)
  } catch {
    return false
  }
}

async function newEcdh(): Promise<{ pair: CryptoKeyPair; pk: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as CryptoKeyPair
  const pk = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  return { pair, pk }
}

async function sharedKey(own: CryptoKeyPair, peerPk: string, salt: Uint8Array): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey('raw', fromBase64Url(peerPk) as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, own.privateKey, 256))
  const digest = await crypto.subtle.digest('SHA-256', concat(salt, bits) as BufferSource)
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

const AD = enc.encode('g2cc-pair-v1/pairing')
const b64 = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)
const Msg = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('hello'), pk: b64, mac: b64 }),
  z.strictObject({ t: z.literal('join'), pk: b64, mac: b64 }),
  z.strictObject({ t: z.literal('pairing'), iv: b64, ct: z.string().regex(/^[A-Za-z0-9_-]{1,8000}$/) }),
  z.strictObject({ t: z.literal('done'), mac: b64 }),
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

/** The channel's side. Send `hello` once connected, then feed it every frame. */
export class ComputerPairing {
  private peerPk: string | null = null
  private constructor(
    readonly roomId: string,
    readonly hello: Uint8Array,
    private readonly secrets: CodeSecrets,
    private readonly ecdh: { pair: CryptoKeyPair; pk: string },
    private readonly pairingText: string,
  ) {}

  static async create(code: string, pairingText: string): Promise<ComputerPairing> {
    const secrets = await codeSecrets(code)
    const ecdh = await newEcdh()
    const hello = frame({ t: 'hello', pk: ecdh.pk, mac: await sign(secrets.mac, `c|${ecdh.pk}`) })
    return new ComputerPairing(secrets.roomId, hello, secrets, ecdh, pairingText)
  }

  /** Frames that fail authentication are ignored; `done` means the phone stored the pairing. */
  async onFrame(f: Uint8Array): Promise<{ send?: Uint8Array; done?: true }> {
    const m = parse(f)
    if (m?.t === 'join' && !this.peerPk) {
      if (!(await verify(this.secrets.mac, `g|${this.ecdh.pk}|${m.pk}`, m.mac))) return {}
      this.peerPk = m.pk
      const key = await sharedKey(this.ecdh.pair, m.pk, this.secrets.salt)
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AD as BufferSource }, key, enc.encode(this.pairingText) as BufferSource),
      )
      return { send: frame({ t: 'pairing', iv: toBase64Url(iv), ct: toBase64Url(ct) }) }
    }
    if (m?.t === 'done' && this.peerPk && (await verify(this.secrets.mac, `d|${this.peerPk}`, m.mac))) return { done: true }
    return {}
  }
}

/** The phone's side. Feed it every frame; it answers `hello` and returns the pairing text. */
export class GlassesPairing {
  private ecdh: { pair: CryptoKeyPair; pk: string } | null = null
  private key: CryptoKey | null = null
  private constructor(
    readonly roomId: string,
    private readonly secrets: CodeSecrets,
  ) {}

  static async create(code: string): Promise<GlassesPairing> {
    const secrets = await codeSecrets(code)
    return new GlassesPairing(secrets.roomId, secrets)
  }

  async onFrame(f: Uint8Array): Promise<{ send?: Uint8Array; pairingText?: string }> {
    const m = parse(f)
    if (m?.t === 'hello' && !this.ecdh) {
      if (!(await verify(this.secrets.mac, `c|${m.pk}`, m.mac))) return {}
      const ecdh = await newEcdh()
      this.ecdh = ecdh
      this.key = await sharedKey(ecdh.pair, m.pk, this.secrets.salt)
      return { send: frame({ t: 'join', pk: ecdh.pk, mac: await sign(this.secrets.mac, `g|${m.pk}|${ecdh.pk}`) }) }
    }
    if (m?.t === 'pairing' && this.key && this.ecdh) {
      try {
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64Url(m.iv) as BufferSource, additionalData: AD as BufferSource },
          this.key,
          fromBase64Url(m.ct) as BufferSource,
        )
        return { pairingText: dec.decode(pt), send: frame({ t: 'done', mac: await sign(this.secrets.mac, `d|${this.ecdh.pk}`) }) }
      } catch {
        return {}
      }
    }
    return {}
  }
}
