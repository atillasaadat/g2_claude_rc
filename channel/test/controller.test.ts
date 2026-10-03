import { describe, expect, test } from 'bun:test'
import { makeEnvelope, type AnyEnvelope, type Body } from '@g2cc/protocol'
import { SessionController, STOP_RESPONSE, type Emitted } from '../src/controller'

const SID = 'sess-1'
const base = { session_id: SID, cwd: '/r', permission_mode: 'default' }

function setup() {
  const out: Emitted[] = []
  const c = new SessionController({ sessionId: SID, name: 'repo', cwd: '/r', emit: e => out.push(e) })
  return { c, out }
}

const stop = (sid?: string): AnyEnvelope => makeEnvelope('stop', {}, sid ? { sid } : {}) as AnyEnvelope
const states = (out: Emitted[]) => out.filter(e => e.kind === 'session').map(e => (e.body as Body<'session'>).state)
const notes = (out: Emitted[]) =>
  out.filter(e => e.kind === 'event' && (e.body as Body<'event'>).type === 'notify').map(e => (e.body as Body<'event'>).summary)

describe('SessionController: stop', () => {
  test('stop while working halts at the next tool call', () => {
    const { c, out } = setup()
    c.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'do things' })
    c.onInbound(stop())
    expect(notes(out)).toContain('Stop requested, halting at the next tool call')
    expect(c.onHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm x' } })).toEqual(STOP_RESPONSE)
    expect(states(out).at(-1)).toBe('stopped')
    expect(notes(out)).toContain('Stopped from glasses')
  })

  test('the stop response is continue:false plus a PreToolUse deny', () => {
    expect(STOP_RESPONSE).toEqual({
      continue: false,
      stopReason: 'Stopped from glasses',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Stopped from glasses',
      },
    })
  })

  test('every tool call in a parallel batch is denied, and the halted tool is not reported as started', () => {
    const { c, out } = setup()
    c.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    c.onInbound(stop())
    const before = out.length
    expect(c.onHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} })).toEqual(STOP_RESPONSE)
    expect(c.onHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: {} })).toEqual(STOP_RESPONSE)
    const starts = out.slice(before).filter(e => e.kind === 'event' && (e.body as Body<'event'>).type === 'tool_start')
    expect(starts).toEqual([])
  })

  test('the next prompt clears the stop flag', () => {
    const { c } = setup()
    c.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    c.onInbound(stop())
    c.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'carry on' })
    expect(c.onHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} })).toEqual({})
  })

  test('stop while idle is ignored with a note, so it cannot block the next turn', () => {
    const { c, out } = setup()
    c.onInbound(stop())
    expect(notes(out)).toContain('Nothing to stop: Claude is idle')
    expect(states(out)).toEqual(['idle'])
    c.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    expect(c.onHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} })).toEqual({})
  })

  test('stop while waiting on a permission prompt still applies', () => {
    const { c } = setup()
    c.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    c.onHook({ ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'm' })
    c.onInbound(stop())
    expect(c.onHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })).toEqual(STOP_RESPONSE)
  })

  test('stop addressed to another session is ignored', () => {
    const { c } = setup()
    c.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    c.onInbound(stop('someone-else'))
    expect(c.onHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} })).toEqual({})
  })

  test('the stopped state survives until the next prompt', () => {
    const { c, out } = setup()
    c.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    c.onInbound(stop())
    c.onHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })
    c.onHook({ ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'waiting' })
    expect(states(out).at(-1)).toBe('stopped')
    c.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'next' })
    expect(states(out).at(-1)).toBe('working')
  })
})

describe('SessionController: hooks', () => {
  test('ignores hooks from other sessions', () => {
    const { c, out } = setup()
    expect(c.onHook({ ...base, session_id: 'other', hook_event_name: 'UserPromptSubmit', prompt: 'x' })).toEqual({})
    expect(out).toEqual([])
  })

  test('accepts all sessions when no session id is known', () => {
    const out: Emitted[] = []
    const c = new SessionController({ name: 'repo', cwd: '/r', emit: e => out.push(e) })
    c.onHook({ ...base, session_id: 'anything', hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    expect(out.length).toBeGreaterThan(0)
  })

  test('emits feed events and session changes', () => {
    const { c, out } = setup()
    c.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hello' })
    expect(out.map(e => e.kind)).toEqual(['event', 'session'])
  })

  test('answers to unknown questions emit nothing', () => {
    const { c, out } = setup()
    c.onInbound(makeEnvelope('answer', { question_id: 'q1', choice: 'a' }) as AnyEnvelope)
    expect(out).toEqual([])
  })
})

describe('SessionController: voice prompts', () => {
  function withPrompts() {
    const out: Emitted[] = []
    const prompts: string[] = []
    const c = new SessionController({ sessionId: SID, name: 'repo', cwd: '/r', emit: e => out.push(e), sendPrompt: t => prompts.push(t) })
    return { c, out, prompts }
  }

  test('a prompt from the glasses is injected into the session', () => {
    const { c, prompts } = withPrompts()
    c.onInbound(makeEnvelope('prompt', { text: 'run the unit tests' }) as AnyEnvelope)
    expect(prompts).toEqual(['run the unit tests'])
  })

  test('while Claude is busy the glasses are told it is queued', () => {
    const { c, out, prompts } = withPrompts()
    c.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    c.onInbound(makeEnvelope('prompt', { text: 'and then lint' }) as AnyEnvelope)
    expect(prompts).toEqual(['and then lint'])
    expect(notes(out)).toContain('Queued for the next turn: Claude is busy')
  })

  test('a prompt for another session is ignored', () => {
    const { c, prompts } = withPrompts()
    c.onInbound(makeEnvelope('prompt', { text: 'x' }, { sid: 'other' }) as AnyEnvelope)
    expect(prompts).toEqual([])
  })
})
