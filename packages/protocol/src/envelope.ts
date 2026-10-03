// Envelope schemas. Every inbound envelope is parsed here after decryption;
// anything that fails is dropped before it can reach Claude Code.

import { z } from 'zod'
import type { Direction } from './crypto'
import { GLANCE_MAX, PROMPT_MAX, QUESTION_OPTIONS_MAX, SHORT_MAX, TEXT_MAX } from './limits'

/** Claude Code permission request IDs: five letters from a-z, excluding l. */
export const REQUEST_ID_RE = /^[a-km-z]{5}$/

const requestId = z.string().regex(REQUEST_ID_RE)
const shortText = z.string().max(SHORT_MAX)
const id = z.string().min(1).max(64)

export const bodySchemas = {
  // computer -> glasses
  session: z.strictObject({
    name: shortText,
    cwd: shortText,
    state: z.enum(['idle', 'working', 'waiting', 'stopped']),
    mode: shortText.optional(),
  }),
  event: z.strictObject({
    type: z.enum(['prompt', 'tool_start', 'tool_end', 'notify']),
    tool: shortText.optional(),
    summary: shortText,
    detail: z.string().max(TEXT_MAX).optional(),
    origin: z.enum(['glasses', 'local']).optional(),
  }),
  reply: z.strictObject({ text: z.string().max(TEXT_MAX) }),
  glance: z.strictObject({ text: z.string().max(GLANCE_MAX) }),
  permission: z.strictObject({
    request_id: requestId,
    tool_name: shortText,
    description: shortText,
    input_preview: z.string().max(TEXT_MAX),
  }),
  permission_resolved: z.strictObject({ request_id: requestId }),
  question: z.strictObject({
    question_id: id,
    question: shortText,
    options: z.array(shortText.min(1)).min(1).max(QUESTION_OPTIONS_MAX),
  }),
  // glasses -> computer
  prompt: z.strictObject({ text: z.string().min(1).max(PROMPT_MAX) }),
  verdict: z.strictObject({ request_id: requestId, behavior: z.enum(['allow', 'deny']) }),
  answer: z.strictObject({ question_id: id, choice: shortText.min(1) }),
  stop: z.strictObject({}),
} as const

export type Kind = keyof typeof bodySchemas
export type Body<K extends Kind> = z.infer<(typeof bodySchemas)[K]>

export const C2G_KINDS = ['session', 'event', 'reply', 'glance', 'permission', 'permission_resolved', 'question'] as const
export const G2C_KINDS = ['prompt', 'verdict', 'answer', 'stop'] as const

const kindsFor: Record<Direction, readonly Kind[]> = { c2g: C2G_KINDS, g2c: G2C_KINDS }

const header = z.strictObject({
  v: z.literal(1),
  id,
  ts: z.number().int().nonnegative(),
  /** Claude Code session ID, for routing once several sessions share the glasses. */
  sid: z.string().max(64).optional(),
  kind: z.string(),
  body: z.unknown(),
})

export type Envelope<K extends Kind = Kind> = {
  v: 1
  id: string
  ts: number
  sid?: string
  kind: K
  body: Body<K>
}

export function makeEnvelope<K extends Kind>(kind: K, body: Body<K>, opts: { sid?: string } = {}): Envelope<K> {
  return { v: 1, id: crypto.randomUUID(), ts: Date.now(), ...(opts.sid ? { sid: opts.sid } : {}), kind, body }
}

/** Validates an envelope that travelled in `dir`. Throws if invalid or in the wrong direction. */
export function parseEnvelope(input: unknown, dir: Direction): Envelope {
  const h = header.parse(input)
  if (!kindsFor[dir].includes(h.kind as Kind)) throw new Error(`kind ${h.kind} not allowed for ${dir}`)
  const kind = h.kind as Kind
  const body = bodySchemas[kind].parse(h.body)
  return { ...h, kind, body } as Envelope
}
