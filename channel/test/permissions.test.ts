import { describe, expect, test } from 'bun:test'
import { makeEnvelope, type AnyEnvelope, type Body } from '@g2cc/protocol'
import { SessionController, type Emitted } from '../src/controller'

const SID = 'sess-1'
const base = { session_id: SID, cwd: '/r', permission_mode: 'default' }
const req = (id = 'abcde', over: Record<string, unknown> = {}) => ({
  request_id: id,
  tool_name: 'Bash',
  description: 'Create empty test file',
  input_preview: '{ "command": "touch perm.txt" }',
  ...over,
})

function setup() {
  const out: Emitted[] = []
  const verdicts: Array<[string, string]> = []
  const c = new SessionController({
    sessionId: SID,
    name: 'repo',
    cwd: '/r',
    emit: e => out.push(e),
    sendVerdict: (id, behavior) => verdicts.push([id, behavior]),
  })
  c.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' })
  out.length = 0
  return { c, out, verdicts }
}

const verdict = (request_id: string, behavior: 'allow' | 'deny') =>
  makeEnvelope('verdict', { request_id, behavior }, { sid: SID }) as AnyEnvelope
const of = <K extends Emitted['kind']>(out: Emitted[], kind: K) =>
  out.filter(e => e.kind === kind).map(e => e.body as Body<K>)

describe('permission relay', () => {
  test('a request is forwarded to the glasses and marks the session waiting', () => {
    const { c, out } = setup()
    c.onPermissionRequest(req())
    expect(of(out, 'permission')).toEqual([req()])
    expect(of(out, 'session').at(-1)?.state).toBe('waiting')
  })

  test('malformed requests are dropped', () => {
    const { c, out } = setup()
    c.onPermissionRequest(req('ABCDE'))
    c.onPermissionRequest(req('abcdl'))
    c.onPermissionRequest({ request_id: 'abcde' })
    c.onPermissionRequest('nope')
    expect(of(out, 'permission')).toEqual([])
  })

  test('display fields are redacted and clipped', () => {
    const { c, out } = setup()
    c.onPermissionRequest(req('abcde', { description: 'Use key sk-proj-abcdefghijklmnopqrstu', input_preview: 'x'.repeat(5000) }))
    const [p] = of(out, 'permission')
    expect(p!.description).not.toContain('abcdefghijklmnop')
    expect(p!.input_preview.length).toBeLessThanOrEqual(2000)
  })

  test('a verdict for a pending request is relayed once and resolves the card', () => {
    const { c, out, verdicts } = setup()
    c.onPermissionRequest(req())
    c.onInbound(verdict('abcde', 'allow'))
    c.onInbound(verdict('abcde', 'deny')) // late duplicate
    expect(verdicts).toEqual([['abcde', 'allow']])
    expect(of(out, 'permission_resolved')).toEqual([{ request_id: 'abcde' }, { request_id: 'abcde' }])
    expect(of(out, 'event').map(e => e.summary)).toContain('Allowed Bash from glasses')
  })

  test('a verdict for an unknown request is not relayed, but tells the glasses to drop the card', () => {
    const { c, out, verdicts } = setup()
    c.onInbound(verdict('zzzzz', 'allow'))
    expect(verdicts).toEqual([])
    expect(of(out, 'permission_resolved')).toEqual([{ request_id: 'zzzzz' }])
  })

  test('an answer in the terminal or on the phone resolves via PostToolUse of the same tool', () => {
    const { c, out, verdicts } = setup()
    c.onPermissionRequest(req('abcde'))
    c.onHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: {} })
    expect(of(out, 'permission_resolved')).toEqual([])
    c.onHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {} })
    expect(of(out, 'permission_resolved')).toEqual([{ request_id: 'abcde' }])
    c.onInbound(verdict('abcde', 'allow'))
    expect(verdicts).toEqual([])
  })

  test('the end of the turn or a new prompt resolves everything still pending (denied elsewhere)', () => {
    const { c, out } = setup()
    c.onPermissionRequest(req('abcde'))
    c.onPermissionRequest(req('fghij', { tool_name: 'Write' }))
    c.onHook({ ...base, hook_event_name: 'Stop', last_assistant_message: 'ok' })
    expect(of(out, 'permission_resolved')).toEqual([{ request_id: 'abcde' }, { request_id: 'fghij' }])
  })

  test('stop denies pending requests, then halts the next tool', () => {
    const { c, verdicts, out } = setup()
    c.onPermissionRequest(req('abcde'))
    c.onInbound(makeEnvelope('stop', {}, { sid: SID }) as AnyEnvelope)
    expect(verdicts).toEqual([['abcde', 'deny']])
    expect(of(out, 'permission_resolved')).toEqual([{ request_id: 'abcde' }])
  })

  test('resync re-sends the session and every pending request', () => {
    const { c, out } = setup()
    c.onPermissionRequest(req('abcde'))
    c.onPermissionRequest(req('fghij'))
    out.length = 0
    c.resync()
    expect(out.map(e => e.kind)).toEqual(['session', 'ack', 'permission', 'permission'])
  })

  test('a card clears when its tool fails, or once Claude is idle after a denial or interrupt elsewhere', () => {
    const { c, out } = setup()
    c.onPermissionRequest(req('abcde'))
    c.onHook({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'Exit code 1' })
    expect(of(out, 'permission_resolved')).toEqual([{ request_id: 'abcde' }])
    // Denied in the terminal or the web view: no PostToolUse and often no Stop, but Claude goes idle.
    c.onPermissionRequest(req('fghij'))
    c.onHook({ ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })
    expect(of(out, 'permission_resolved')).toEqual([{ request_id: 'abcde' }, { request_id: 'fghij' }])
  })

  test('a card settled in the terminal or web view without the tool running clears from the transcript', () => {
    const { c, out } = setup()
    c.onHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_a', tool_input: { command: 'touch x' } })
    c.onPermissionRequest(req('abcde'))
    expect(c.wantsTranscript()).toBe(true)
    // Denied there: the transcript gets the tool result and the turn is interrupted, with no hook at all.
    c.onTranscriptNews({ toolResults: ['toolu_a'], interrupted: true })
    expect(of(out, 'permission_resolved')).toEqual([{ request_id: 'abcde' }])
    expect(of(out, 'session').at(-1)?.state).toBe('idle')
    expect(c.wantsTranscript()).toBe(false)
  })

  test('a result for another call leaves the card alone', () => {
    const { c, out } = setup()
    c.onHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_a', tool_input: { command: 'touch x' } })
    c.onPermissionRequest(req('abcde'))
    c.onTranscriptNews({ toolResults: ['toolu_other'], interrupted: false })
    expect(of(out, 'permission_resolved')).toEqual([])
  })
})

