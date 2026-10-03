// One side of an encrypted link. Combines framing, schema validation, and
// replay protection so callers cannot skip a step.

import { deriveRoomId, importKey, openFrame, sealFrame, type Direction } from './crypto'
import { C2G_KINDS, G2C_KINDS, makeEnvelope, parseEnvelope, type Body, type Envelope, type Kind } from './envelope'
import { COMMAND_MAX_AGE_MS, DISPLAY_MAX_AGE_MS, MAX_FRAME_BYTES, MAX_SKEW_MS } from './limits'
import { ReplayGuard } from './replay'

export type Side = 'computer' | 'glasses'
export type OutKind<S extends Side> = S extends 'computer' ? (typeof C2G_KINDS)[number] : (typeof G2C_KINDS)[number]

const enc = new TextEncoder()
const dec = new TextDecoder()

export class SecureChannel<S extends Side = Side> {
  private readonly guard: ReplayGuard

  private constructor(
    readonly side: S,
    readonly roomId: string,
    private readonly key: CryptoKey,
  ) {
    // The computer receives commands (strict window). The glasses receive
    // display data, which the relay may replay from history.
    this.guard = new ReplayGuard({
      maxAgeMs: side === 'computer' ? COMMAND_MAX_AGE_MS : DISPLAY_MAX_AGE_MS,
      maxSkewMs: MAX_SKEW_MS,
    })
  }

  static async create<S extends Side>(rawKey: Uint8Array, side: S): Promise<SecureChannel<S>> {
    return new SecureChannel(side, await deriveRoomId(rawKey), await importKey(rawKey))
  }

  private get outDir(): Direction {
    return this.side === 'computer' ? 'c2g' : 'g2c'
  }

  private get inDir(): Direction {
    return this.side === 'computer' ? 'g2c' : 'c2g'
  }

  async seal<K extends OutKind<S>>(kind: K, body: Body<K>, opts: { sid?: string } = {}): Promise<Uint8Array> {
    // Validate our own output too, so a bug never ships a malformed envelope.
    const env = parseEnvelope(makeEnvelope(kind as Kind, body as Body<Kind>, opts), this.outDir)
    const frame = await sealFrame(this.key, this.roomId, this.outDir, enc.encode(JSON.stringify(env)))
    if (frame.length > MAX_FRAME_BYTES) throw new Error('envelope too large')
    return frame
  }

  /** Returns the envelope, or null if it fails decryption, validation, or replay checks. */
  async open(frame: Uint8Array): Promise<Envelope | null> {
    if (frame.length > MAX_FRAME_BYTES) return null
    try {
      const plaintext = await openFrame(this.key, this.roomId, this.inDir, frame)
      const env = parseEnvelope(JSON.parse(dec.decode(plaintext)), this.inDir)
      return this.guard.check(env) ? env : null
    } catch {
      return null
    }
  }
}
