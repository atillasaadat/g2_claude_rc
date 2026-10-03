import { describe, expect, test } from 'bun:test'
import { makeEnvelope, type AnyEnvelope, type Body } from '@g2cc/protocol'
import { ASK_DENY_REASON, SessionController, type Emitted } from '../src/controller'

const SID = 'sess-1'
const base = { session_id: SID, cwd: '/r', permission_mode: 'default' }

function setup(glasses = true) {
  const out: Emitted[] = []
  const answers: Array<{ content: string; questionId: string }> = []
  const c = new SessionController({
    sessionId: SID,
    name: 'repo',
    cwd: '/r',
    emit: e => out.push(e),
    sendAnswer: (content, questionId) => answers.push({ content, questionId }),
  })
  c.setGlassesPresent(glasses)
  return { c, out, answers }
}
const questions = (out: Emitted[]) => out.filter(e => e.kind === 'question').map(e => e.body as Body<'question'>)
const answer = (question_id: string, choice: string) => makeEnvelope('answer', { question_id, choice }, { sid: SID }) as AnyEnvelope

describe('ask tool', () => {
  test('sends the question to the glasses and tells Claude to end its turn', () => {
    const { c, out } = setup()
    const r = c.onAsk({ question: 'Which branch?', options: ['main', 'dev'] })
    expect(r.ok).toBe(true)
    const [q] = questions(out)
    expect(q).toMatchObject({ question: 'Which branch?', options: ['main', 'dev'] })
    expect(q!.question_id).toMatch(/^q[0-9a-f]{8}$/)
    expect(r.text).toContain(q!.question_id)
    expect(r.text).toContain('end your turn')
  })

  test.each([
    [{ question: '', options: ['a', 'b'] }],
    [{ question: 'q?', options: [] }],
    [{ question: 'q?', options: ['a', 'b', 'c', 'd', 'e'] }],
    [{ question: 'q?', options: ['a', ''] }],
    [{ question: 'q?' }],
    ['nope'],
  ])('rejects bad input %#', input => {
    const { c, out } = setup()
    expect(c.onAsk(input).ok).toBe(false)
    expect(questions(out)).toEqual([])
  })

  test('redacts and clips display text', () => {
    const { c, out } = setup()
    c.onAsk({ question: 'Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789?', options: ['x'.repeat(500), 'no'] })
    const [q] = questions(out)
    expect(q!.question).not.toContain('abcdefghijklmnop')
    expect(q!.options[0]!.length).toBeLessThanOrEqual(100)
  })

  test('an answer is delivered once as a channel event with the question id', () => {
    const { c, out, answers } = setup()
    c.onAsk({ question: 'Which branch?', options: ['main', 'dev'] })
    const id = questions(out)[0]!.question_id
    c.onInbound(answer(id, 'dev'))
    c.onInbound(answer(id, 'main'))
    expect(answers).toEqual([{ content: 'The user answered your question "Which branch?": dev', questionId: id }])
  })

  test('an answer that is not one of the options is ignored', () => {
    const { c, out, answers } = setup()
    c.onAsk({ question: 'Which branch?', options: ['main', 'dev'] })
    c.onInbound(answer(questions(out)[0]!.question_id, 'rm -rf /'))
    expect(answers).toEqual([])
  })

  test('an answer to an unknown question is ignored', () => {
    const { c, answers } = setup()
    c.onInbound(answer('q00000000', 'main'))
    expect(answers).toEqual([])
  })

  test('pending questions survive new prompts (the answer itself arrives as one) and resync re-sends them', () => {
    const { c, out } = setup()
    c.onAsk({ question: 'Which branch?', options: ['main', 'dev'] })
    c.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    c.onHook({ ...base, hook_event_name: 'Stop' })
    out.length = 0
    c.resync()
    expect(questions(out)).toHaveLength(1)
  })
})

describe('AskUserQuestion redirect', () => {
  const ask = { ...base, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: {} }

  test('is denied with a pointer to mcp__g2__ask while glasses are connected', () => {
    const { c } = setup(true)
    expect(c.onHook(ask)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: ASK_DENY_REASON },
    })
    expect(ASK_DENY_REASON).toContain('mcp__g2__ask')
  })

  test('is allowed when no glasses are connected', () => {
    const { c } = setup(false)
    expect(c.onHook(ask)).toEqual({})
  })
})

describe('own tools under the plugin', () => {
  const pre = (tool_name: string) => ({ ...base, hook_event_name: 'PreToolUse', tool_name, tool_input: {} })
  const ALLOW = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
  const plugin = (glasses: boolean) => {
    const out: Emitted[] = []
    const c = new SessionController({ sessionId: SID, name: 'repo', cwd: '/r', emit: e => out.push(e), ownToolPrefix: 'mcp__plugin_g2_g2__', autoAllowOwnTools: true })
    c.setGlassesPresent(glasses)
    return c
  }

  test('the plugin allows its own ask and glance without a prompt', () => {
    const c = plugin(true)
    for (const n of ['mcp__plugin_g2_g2__ask', 'mcp__plugin_g2_g2__glance']) expect(c.onHook(pre(n))).toEqual(ALLOW)
  })

  test('look-alike tools from another server named g2, and pair, keep the normal prompt', () => {
    const c = plugin(true)
    for (const n of ['mcp__g2__ask', 'mcp__g2__glance', 'mcp__plugin_g2_g2__pair']) expect(c.onHook(pre(n))).toEqual({})
  })

  test('a from-source channel never auto-allows (settings.json lists the tools)', () => {
    const { c } = setup(true)
    expect(c.onHook(pre('mcp__g2__ask'))).toEqual({})
  })

  test('the deny reason names the plugin tool too', () => {
    expect(ASK_DENY_REASON).toContain('mcp__plugin_g2_g2__ask')
  })
})
