// Envelope schemas. Every inbound envelope is parsed here after decryption;
// anything that fails is dropped before it can reach Claude Code.

import { z } from 'zod'
import type { Direction } from './crypto'
import { GLANCE_MAX, HISTORY_ITEMS_MAX, PROMPT_MAX, QUESTION_OPTIONS_MAX, SHORT_MAX, TEXT_MAX } from './limits'

/** Claude Code permission request IDs: five letters from a-z, excluding l. */
export const REQUEST_ID_RE = /^[a-km-z]{5}$/

const requestId = z.string().regex(REQUEST_ID_RE)
const shortText = z.string().max(SHORT_MAX)
const id = z.string().min(1).max(64)

const eventBody = z.strictObject({
  type: z.enum(['prompt', 'tool_start', 'tool_end', 'notify']),
  tool: shortText.optional(),
  summary: shortText,
  detail: z.string().max(TEXT_MAX).optional(),
  origin: z.enum(['glasses', 'local']).optional(),
})
const replyBody = z.strictObject({ text: z.string().max(TEXT_MAX) })
const glanceBody = z.strictObject({ text: z.string().max(GLANCE_MAX) })
const itemHead = { id, ts: z.number().int().nonnegative() }

/** One earlier feed envelope, as it was sent (same id and ts). */
export const historyItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...itemHead, kind: z.literal('event'), body: eventBody }),
  z.strictObject({ ...itemHead, kind: z.literal('reply'), body: replyBody }),
  z.strictObject({ ...itemHead, kind: z.literal('glance'), body: glanceBody }),
])
export type HistoryItem = z.infer<typeof historyItemSchema>

export const bodySchemas = {
  // computer -> glasses
  session: z.strictObject({
    name: shortText,
    cwd: shortText,
    // 'ended': the session's channel shut down (it leaves the glasses' session list).
    state: z.enum(['idle', 'working', 'waiting', 'stopped', 'ended']),
    mode: shortText.optional(),
  }),
  event: eventBody,
  reply: replyBody,
  glance: glanceBody,
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
  /** Answered elsewhere (the terminal), or withdrawn: dismiss the card. */
  question_resolved: z.strictObject({ question_id: id }),
  /**
   * The channel got these commands (envelope ids), including resends it had
   * already acted on. Empty: sent on every resync, to say this channel acks.
   * Older apps drop the unknown kind.
   */
  ack: z.strictObject({ ids: z.array(id).max(20) }),
  /**
   * The session's recent feed, oldest first, sent on every resync. The relay's
   * history is shared by every session on the computer and fills up with
   * resyncs, so this is how a phone that opens later still sees what happened.
   * Older apps drop the unknown kind.
   */
  history: z.strictObject({ items: z.array(historyItemSchema).max(HISTORY_ITEMS_MAX) }),
  // glasses -> computer
  prompt: z.strictObject({ text: z.string().min(1).max(PROMPT_MAX) }),
  verdict: z.strictObject({ request_id: requestId, behavior: z.enum(['allow', 'deny']) }),
  answer: z.strictObject({ question_id: id, choice: shortText.min(1) }),
  stop: z.strictObject({}),
} as const

export type Kind = keyof typeof bodySchemas
export type Body<K extends Kind> = z.infer<(typeof bodySchemas)[K]>

export const C2G_KINDS = ['session', 'event', 'reply', 'glance', 'permission', 'permission_resolved', 'question', 'question_resolved', 'ack', 'history'] as const
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

/** Discriminated union: narrowing on `kind` narrows `body`. */
export type AnyEnvelope = { [K in Kind]: Envelope<K> }[Kind]

export function makeEnvelope<K extends Kind>(kind: K, body: Body<K>, opts: { sid?: string } = {}): Envelope<K> {
  return { v: 1, id: crypto.randomUUID(), ts: Date.now(), ...(opts.sid ? { sid: opts.sid } : {}), kind, body }
}

/** Validates an envelope that travelled in `dir`. Throws if invalid or in the wrong direction. */
export function parseEnvelope(input: unknown, dir: Direction): AnyEnvelope {
  const h = header.parse(input)
  if (!kindsFor[dir].includes(h.kind as Kind)) throw new Error(`kind ${h.kind} not allowed for ${dir}`)
  const kind = h.kind as Kind
  const body = bodySchemas[kind].parse(h.body)
  return { ...h, kind, body } as AnyEnvelope
}
