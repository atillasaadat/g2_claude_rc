// Per-session logic, independent of transports: hook payloads in, envelopes
// out, plus inbound commands from the glasses.
//
// Stop (Phase 4): the glasses send `stop`, which sets a flag. The next
// PreToolUse gets continue:false plus a deny. Phase 0 showed continue:false
// alone lets the pending tool run first. The flag stays up until the next
// prompt, so every call in a parallel batch is denied, and the Stop hook does
// not fire after a halt, so the state is set to 'stopped' here.

import type { AnyEnvelope, Body, C2G_KINDS } from '@g2cc/protocol'
import type { HookResponse } from './hook-server'
import { SessionTracker, translateHook, type HookPayload } from './hooks'

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

export interface ControllerOptions {
  /** CLAUDE_CODE_SESSION_ID. When unknown, hooks from any session are accepted. */
  sessionId?: string
  name: string
  cwd: string
  emit: (e: Emitted) => void
}

export class SessionController {
  private readonly tracker: SessionTracker
  private stopRequested = false

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

  onHook(p: HookPayload): HookResponse {
    if (this.opts.sessionId && p.session_id !== this.opts.sessionId) return {}

    if (p.hook_event_name === 'UserPromptSubmit') this.stopRequested = false

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
        this.note('Stop requested, halting at the next tool call')
        return
      }
      default:
        // prompt, verdict, answer: later phases.
        return
    }
  }
}
