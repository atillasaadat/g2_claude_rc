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

import { z } from 'zod'
import { REQUEST_ID_RE, type AnyEnvelope, type Body, type C2G_KINDS } from '@g2cc/protocol'
import type { HookResponse } from './hook-server'
import { SessionTracker, translateHook, type HookPayload } from './hooks'
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
}

export class SessionController {
  private readonly tracker: SessionTracker
  private stopRequested = false
  /** Insertion-ordered, so the oldest request of a tool resolves first. */
  private readonly pending = new Map<string, Pending>()

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

    // After a halt, only a new prompt leaves 'stopped' (idle notifications do not).
    const stopped = this.tracker.snapshot().state === 'stopped'
    const session = stopped && p.hook_event_name !== 'UserPromptSubmit' ? null : this.tracker.update(p)
    for (const out of translateHook(p)) this.opts.emit(out)
    this.emitSession(session)
    return {}
  }

  onInbound(env: AnyEnvelope): void {
    if (env.sid && this.opts.sessionId && env.sid !== this.opts.sessionId) return
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
      default:
        // answer: Phase 7.
        return
    }
  }
}
