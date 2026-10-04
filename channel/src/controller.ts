// Per-session logic, independent of transports: hook payloads in, envelopes
// out, plus inbound commands from the glasses.
//
// Stop (Phase 4): the glasses send `stop`, which sets a flag. The next
// PreToolUse gets continue:false plus a deny. Phase 0 showed continue:false
// alone lets the pending tool run first. The flag stays up until the next
// prompt, so every call in a parallel batch is denied, and the Stop hook does
// not fire after a halt, so the state is set to 'stopped' here.
//
// Permission relay (Phase 5): Claude Code sends permission_request; the card
// goes to the glasses; a verdict is relayed only while its request is
// pending. Claude Code never says when a request was settled in the terminal
// or on the phone, so PostToolUse of the same tool, the end of the turn, or a
// new prompt resolves it (docs/decisions.md, check #8).
//
// Questions (Phase 7): the ask tool sends a question card and returns at
// once. Channel events only arrive between turns, so Claude ends its turn and
// the answer comes back as a channel message carrying question_id.

import { z } from 'zod'
import { REQUEST_ID_RE, type AnyEnvelope, type Body, type C2G_KINDS } from '@g2cc/protocol'
import type { HookResponse } from './hook-socket'
import { isDisplayTool, SessionTracker, translateHook, type HookPayload } from './hooks'
import { clip, oneLine, redact } from './redact'

type C2GKind = (typeof C2G_KINDS)[number]
export type Emitted = { [K in C2GKind]: { kind: K; body: Body<K> } }[C2GKind]

export const STOP_REASON = 'Stopped from glasses'
export const STOP_RESPONSE: HookResponse = {
  continue: false,
  stopReason: STOP_REASON,
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: STOP_REASON,
  },
}

/** notifications/claude/channel/permission_request params, verified in Phase 0. */
const PermissionRequest = z.object({
  request_id: z.string().regex(REQUEST_ID_RE),
  tool_name: z.string(),
  description: z.string(),
  input_preview: z.string(),
})
type Pending = Body<'permission'>

export const PREVIEW_MAX = 2000
export const OPTION_MAX = 100

export const ASK_DENY_REASON =
  'The user is following this session on smart glasses and cannot see this dialog. Call the g2 ask tool (mcp__g2__ask, or mcp__plugin_g2_g2__ask when g2 is installed as a plugin) with the question and 2 to 4 short options instead. It shows the question on the glasses and in the terminal and returns the user\'s choice.'

const AskInput = z.object({
  question: z.string().trim().min(1),
  options: z.array(z.string().trim().min(1)).min(1).max(4),
})

export type AskResult = { ok: boolean; text: string; question?: Body<'question'> }

const newQuestionId = (): string =>
  'q' + Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')

export interface ControllerOptions {
  /** CLAUDE_CODE_SESSION_ID. When unknown, hooks from any session are accepted. */
  sessionId?: string
  name: string
  cwd: string
  emit: (e: Emitted) => void
  /** Sends notifications/claude/channel/permission back to Claude Code. */
  sendVerdict?: (requestId: string, behavior: 'allow' | 'deny') => void
  /** Injects a confirmed voice prompt as a notifications/claude/channel event. */
  sendPrompt?: (text: string) => void
  /** Injects the answer to an ask question as a channel event with meta.question_id. */
  sendAnswer?: (content: string, questionId: string) => void
  /** Prefix of this channel's own tool names (hooks.ts ownToolPrefix). Defaults to mcp__g2__. */
  ownToolPrefix?: string
  /**
   * Allow our own ask and glance from the PreToolUse hook. Only for the
   * plugin, which cannot ship permission rules; a from-source setup lists them
   * in settings.json instead.
   */
  autoAllowOwnTools?: boolean
}

export class SessionController {
  private get prefix(): string {
    return this.opts.ownToolPrefix ?? 'mcp__g2__'
  }
  private readonly tracker: SessionTracker
  private stopRequested = false
  /** Insertion-ordered, so the oldest request of a tool resolves first. */
  private readonly pending = new Map<string, Pending>()
  private readonly questions = new Map<string, Body<'question'>>()
  /** Questions whose ask call is still waiting (shown in the terminal too): a glasses answer goes there, not to a channel message. */
  private readonly waiting = new Map<string, (choice: string) => void>()
  private glassesPresent = false

  constructor(private readonly opts: ControllerOptions) {
    this.tracker = new SessionTracker({ name: opts.name, cwd: opts.cwd })
  }

  snapshot(): Body<'session'> {
    return this.tracker.snapshot()
  }

  private note(summary: string): void {
    this.opts.emit({ kind: 'event', body: { type: 'notify', summary } })
  }

  private emitSession(body: Body<'session'> | null): void {
    if (body) this.opts.emit({ kind: 'session', body })
  }

  /** Session header plus every pending request, freshly stamped (glasses (re)connect). */
  resync(): void {
    this.emitSession(this.tracker.snapshot())
    for (const p of this.pending.values()) this.opts.emit({ kind: 'permission', body: p })
    for (const q of this.questions.values()) this.opts.emit({ kind: 'question', body: q })
  }

  /** AskUserQuestion is only redirected to the glasses while they are connected. */
  setGlassesPresent(present: boolean): void {
    this.glassesPresent = present
  }

  onAsk(input: unknown): AskResult {
    const parsed = AskInput.safeParse(input)
    if (!parsed.success) return { ok: false, text: 'ask needs a non-empty question and 1 to 4 non-empty options.' }
    const question_id = newQuestionId()
    const body: Body<'question'> = {
      question_id,
      question: clip(oneLine(redact(parsed.data.question)), 500),
      options: parsed.data.options.map(o => clip(oneLine(redact(o)), OPTION_MAX)),
    }
    this.questions.set(question_id, body)
    this.opts.emit({ kind: 'question', body })
    return {
      ok: true,
      question: body,
      text:
        `Asked on the user's glasses (question_id=${question_id}). Do not wait or call ask again: end your turn now. ` +
        `The answer arrives later as a g2 channel message with question_id="${question_id}".`,
    }
  }

  /**
   * The ask call waits for this question. Resolves with the glasses' choice;
   * call `stop` once the call no longer waits (answered in the terminal, or
   * given up), after which a glasses answer becomes a channel message again.
   */
  awaitGlassesAnswer(questionId: string): { answer: Promise<string>; stop: () => void } {
    let settle: (choice: string) => void = () => {}
    const answer = new Promise<string>(resolve => (settle = resolve))
    this.waiting.set(questionId, settle)
    return { answer, stop: () => this.waiting.delete(questionId) }
  }

  /** Answered somewhere other than the glasses: drop it and dismiss the card there. */
  resolveQuestion(questionId: string): void {
    this.waiting.delete(questionId)
    if (!this.questions.delete(questionId)) return
    this.opts.emit({ kind: 'question_resolved', body: { question_id: questionId } })
  }

  onPermissionRequest(params: unknown): void {
    const parsed = PermissionRequest.safeParse(params)
    if (!parsed.success) return
    const r = parsed.data
    // Untrusted display text: redact, flatten, clip. Never executed.
    const body: Pending = {
      request_id: r.request_id,
      tool_name: clip(oneLine(r.tool_name), 100),
      description: clip(oneLine(redact(r.description)), 300),
      input_preview: clip(redact(r.input_preview), PREVIEW_MAX),
    }
    this.pending.set(r.request_id, body)
    this.opts.emit({ kind: 'permission', body })
    this.emitSession(this.tracker.set('waiting'))
  }

  private resolve(requestId: string): void {
    this.pending.delete(requestId)
    this.opts.emit({ kind: 'permission_resolved', body: { request_id: requestId } })
  }

  private resolveAll(): void {
    for (const id of [...this.pending.keys()]) this.resolve(id)
  }

  onHook(p: HookPayload): HookResponse {
    if (this.opts.sessionId && p.session_id !== this.opts.sessionId) return {}

    if (p.hook_event_name === 'UserPromptSubmit') this.stopRequested = false
    if (p.hook_event_name === 'UserPromptSubmit' || p.hook_event_name === 'Stop') this.resolveAll()
    if (p.hook_event_name === 'PostToolUse') {
      const match = [...this.pending.values()].find(q => q.tool_name === p.tool_name)
      if (match) this.resolve(match.request_id)
    }

    if (p.hook_event_name === 'PreToolUse' && this.stopRequested) {
      if (this.tracker.snapshot().state !== 'stopped') {
        this.emitSession(this.tracker.set('stopped'))
        this.note(STOP_REASON)
      }
      return STOP_RESPONSE
    }

    if (p.hook_event_name === 'PreToolUse' && p.tool_name === 'AskUserQuestion' && this.glassesPresent) {
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: ASK_DENY_REASON },
      }
    }

    // A plugin cannot add permission rules, so our own display-only tools are
    // allowed here. They never touch files or run commands.
    if (p.hook_event_name === 'PreToolUse' && this.opts.autoAllowOwnTools && p.tool_name && isDisplayTool(p.tool_name, this.prefix)) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
    }

    // After a halt, only a new prompt leaves 'stopped' (idle notifications do not).
    const stopped = this.tracker.snapshot().state === 'stopped'
    const session = stopped && p.hook_event_name !== 'UserPromptSubmit' ? null : this.tracker.update(p)
    for (const out of translateHook(p, this.prefix)) this.opts.emit(out)
    this.emitSession(session)
    return {}
  }

  onInbound(env: AnyEnvelope): void {
    // Several sessions share the room, so commands must name this session.
    // Fails closed: without a known session id, nothing from the glasses is acted on.
    if (!this.opts.sessionId || env.sid !== this.opts.sessionId) return
    switch (env.kind) {
      case 'stop': {
        const state = this.tracker.snapshot().state
        if (state === 'idle' || state === 'stopped') {
          this.note('Nothing to stop: Claude is idle')
          // Re-send the state so the glasses can clear their "stopping" marker.
          this.opts.emit({ kind: 'session', body: this.tracker.snapshot() })
          return
        }
        this.stopRequested = true
        // An open permission dialog would block forever: deny it so the halt can happen.
        for (const id of [...this.pending.keys()]) {
          this.opts.sendVerdict?.(id, 'deny')
          this.resolve(id)
        }
        this.note('Stop requested, halting at the next tool call')
        return
      }
      case 'verdict': {
        const { request_id, behavior } = env.body
        const pending = this.pending.get(request_id)
        if (!pending) {
          // Settled elsewhere or unknown: never relay, but clear the card.
          this.opts.emit({ kind: 'permission_resolved', body: { request_id } })
          return
        }
        this.opts.sendVerdict?.(request_id, behavior)
        this.resolve(request_id)
        this.note(`${behavior === 'allow' ? 'Allowed' : 'Denied'} ${pending.tool_name} from glasses`)
        return
      }
      case 'prompt': {
        // Channel events queue while Claude is busy and arrive on the next turn.
        const state = this.tracker.snapshot().state
        this.opts.sendPrompt?.(env.body.text)
        if (state === 'working' || state === 'waiting') this.note('Queued for the next turn: Claude is busy')
        return
      }
      case 'answer': {
        const q = this.questions.get(env.body.question_id)
        // Only one of the offered options, and only once.
        if (!q || !q.options.includes(env.body.choice)) return
        this.questions.delete(q.question_id)
        const waiter = this.waiting.get(q.question_id)
        if (waiter) {
          this.waiting.delete(q.question_id)
          waiter(env.body.choice)
          return
        }
        this.opts.sendAnswer?.(`The user answered your question "${q.question}": ${env.body.choice}`, q.question_id)
        return
      }
      default:
        return
    }
  }
}
