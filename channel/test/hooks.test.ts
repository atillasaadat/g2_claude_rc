import { describe, expect, test } from 'bun:test'
import { G2_TOOL, SessionTracker, translateHook, type HookPayload } from '../src/hooks'

const base = { session_id: 's1', cwd: '/home/u/repo', permission_mode: 'default' }
const pre = (tool_name: string, tool_input: unknown): HookPayload => ({ ...base, hook_event_name: 'PreToolUse', tool_name, tool_input })
const post = (tool_name: string, tool_input: unknown, tool_response: unknown): HookPayload => ({
  ...base,
  hook_event_name: 'PostToolUse',
  tool_name,
  tool_input,
  tool_response,
})

describe('translateHook: tool_start summaries', () => {
  test.each([
    [pre('Bash', { command: 'ls -la\necho two' }), 'Bash', 'ls -la echo two'],
    [pre('Read', { file_path: '/home/u/repo/src/a.ts' }), 'Read', 'src/a.ts'],
    [pre('Edit', { file_path: '/elsewhere/b.ts' }), 'Edit', '/elsewhere/b.ts'],
    [pre('Write', { file_path: '/home/u/repo/README.md' }), 'Write', 'README.md'],
    [pre('Grep', { pattern: 'TODO', path: 'src' }), 'Grep', '"TODO" in src'],
    [pre('Glob', { pattern: '**/*.ts' }), 'Glob', '**/*.ts'],
    [pre('WebFetch', { url: 'https://example.com/docs?q=1' }), 'WebFetch', 'example.com/docs'],
    [pre('WebSearch', { query: 'bun websocket' }), 'WebSearch', 'bun websocket'],
    [pre('Task', { description: 'Explore repo' }), 'Task', 'Explore repo'],
    [pre('mcp__github__create_issue', { title: 'x' }), 'github:create_issue', 'github:create_issue'],
    [pre('SomethingNew', { x: 1 }), 'SomethingNew', 'SomethingNew'],
  ])('%#', (payload, tool, summary) => {
    expect(translateHook(payload)).toEqual([{ kind: 'event', body: { type: 'tool_start', tool, summary } }])
  })

  test('hides tool discovery and our own channel tools', () => {
    expect(translateHook(pre('ToolSearch', { query: 'select:x' }))).toEqual([])
    expect(translateHook(pre('mcp__g2__glance', { text: 'hi' }))).toEqual([])
    expect(translateHook(post('mcp__g2__glance', { text: 'hi' }, {}))).toEqual([])
  })

  test('redacts secrets in commands', () => {
    const [out] = translateHook(pre('Bash', { command: 'curl -H "Authorization: Bearer abcdef123456" x' }))
    expect(JSON.stringify(out)).not.toContain('abcdef123456')
  })

  test('caps summary length', () => {
    const [out] = translateHook(pre('Bash', { command: 'x'.repeat(1000) }))
    expect((out!.body as { summary: string }).summary.length).toBeLessThanOrEqual(200)
  })
})

describe('translateHook: tool_end summaries', () => {
  test('Bash ok', () => {
    const p = post('Bash', { command: 'ls' }, { stdout: 'a', stderr: '', interrupted: false })
    expect(translateHook(p)).toEqual([{ kind: 'event', body: { type: 'tool_end', tool: 'Bash', summary: 'ok' } }])
  })

  test('Bash with stderr shows its first line', () => {
    const p = post('Bash', { command: 'x' }, { stdout: '', stderr: 'x: not found\nmore', interrupted: false })
    expect(translateHook(p)[0]!.body).toEqual({ type: 'tool_end', tool: 'Bash', summary: 'ok, stderr: x: not found' })
  })

  test('Bash interrupted', () => {
    const p = post('Bash', { command: 'sleep 9' }, { stdout: '', stderr: '', interrupted: true })
    expect(translateHook(p)[0]!.body).toEqual({ type: 'tool_end', tool: 'Bash', summary: 'interrupted' })
  })

  test('file tools name the file', () => {
    expect(translateHook(post('Edit', { file_path: '/home/u/repo/a.ts' }, {}))[0]!.body).toEqual({
      type: 'tool_end',
      tool: 'Edit',
      summary: 'edited a.ts',
    })
    expect(translateHook(post('Write', { file_path: '/home/u/repo/b.ts' }, {}))[0]!.body).toEqual({
      type: 'tool_end',
      tool: 'Write',
      summary: 'wrote b.ts',
    })
  })

  test('other tools say done', () => {
    expect(translateHook(post('Read', { file_path: 'a' }, {}))[0]!.body).toEqual({ type: 'tool_end', tool: 'Read', summary: 'done' })
  })
})

describe('translateHook: prompts, notifications, replies', () => {
  test('a typed prompt is local', () => {
    const p: HookPayload = { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'run the tests' }
    expect(translateHook(p)).toEqual([{ kind: 'event', body: { type: 'prompt', summary: 'run the tests', origin: 'local' } }])
  })

  test('a channel prompt from g2 is unwrapped and marked as glasses', () => {
    const prompt = '<channel source="g2" source_kind="voice">\nrun the tests\n</channel>'
    const p: HookPayload = { ...base, hook_event_name: 'UserPromptSubmit', prompt }
    expect(translateHook(p)).toEqual([{ kind: 'event', body: { type: 'prompt', summary: 'run the tests', origin: 'glasses' } }])
  })

  test('a channel prompt from another source stays local and wrapped', () => {
    const prompt = '<channel source="fakechat">\nhello\n</channel>'
    const p: HookPayload = { ...base, hook_event_name: 'UserPromptSubmit', prompt }
    expect(translateHook(p)[0]!.body).toMatchObject({ origin: 'local' })
  })

  test('notification', () => {
    const p: HookPayload = { ...base, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }
    expect(translateHook(p)).toEqual([
      { kind: 'event', body: { type: 'notify', summary: 'Claude needs your permission to use Bash' } },
    ])
  })

  test('idle reminders are dropped from the feed', () => {
    const p: HookPayload = { ...base, hook_event_name: 'Notification', message: 'Claude is waiting for your input', notification_type: 'idle_prompt' }
    expect(translateHook(p)).toEqual([])
  })

  test('stop emits the final reply, redacted', () => {
    const p: HookPayload = { ...base, hook_event_name: 'Stop', last_assistant_message: 'Set PASSWORD=hunter2 and done.' }
    expect(translateHook(p)).toEqual([{ kind: 'reply', body: { text: 'Set PASSWORD=[REDACTED] and done.' } }])
  })

  test('stop without a message emits nothing', () => {
    expect(translateHook({ ...base, hook_event_name: 'Stop' })).toEqual([])
  })

  test('unknown events and malformed payloads emit nothing', () => {
    expect(translateHook({ ...base, hook_event_name: 'SessionStart' })).toEqual([])
    expect(translateHook({ hook_event_name: 'PreToolUse' } as HookPayload)).toEqual([])
  })
})

describe('SessionTracker', () => {
  const tracker = () => new SessionTracker({ name: 'repo', cwd: '/home/u/repo' })

  test('starts idle', () => {
    expect(tracker().snapshot()).toEqual({ name: 'repo', cwd: '/home/u/repo', state: 'idle' })
  })

  test('moves through working, waiting, idle and reports only changes', () => {
    const t = tracker()
    expect(t.update({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' })).toEqual({
      name: 'repo',
      cwd: '/home/u/repo',
      state: 'working',
      mode: 'default',
    })
    expect(t.update(pre('Bash', { command: 'ls' }))).toBeNull()
    expect(t.update({ ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'm' })?.state).toBe('waiting')
    expect(t.update(post('Bash', { command: 'ls' }, {}))?.state).toBe('working')
    expect(t.update({ ...base, hook_event_name: 'Stop' })?.state).toBe('idle')
  })

  test('reports a mode change', () => {
    const t = tracker()
    t.update({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    expect(t.update({ ...pre('Read', {}), permission_mode: 'auto' })?.mode).toBe('auto')
  })

  test('idle_prompt notifications mean idle', () => {
    const t = tracker()
    t.update({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    expect(t.update({ ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'm' })?.state).toBe('idle')
  })
})

describe('plugin naming', () => {
  test('plugin tool names are hidden from the feed, pair included', () => {
    expect(translateHook(pre('mcp__plugin_g2_g2__glance', { text: 'hi' }))).toEqual([])
    expect(translateHook(post('mcp__plugin_g2_g2__pair', {}, { code: 'ABCD-EFGH' }))).toEqual([])
  })

  test('G2_TOOL matches only the display tools under both names', () => {
    for (const n of ['mcp__g2__ask', 'mcp__g2__glance', 'mcp__plugin_g2_g2__ask', 'mcp__plugin_g2_g2__glance'])
      expect(G2_TOOL.test(n)).toBe(true)
    for (const n of ['mcp__g2__pair', 'mcp__plugin_g2_g2__pair', 'mcp__evil_g2__ask', 'Bash']) expect(G2_TOOL.test(n)).toBe(false)
  })
})

test('a channel prompt from the g2 plugin is unwrapped and marked as glasses', () => {
  const prompt = '<channel source="plugin:g2:g2" source_kind="voice">\nrun the tests\n</channel>'
  const p: HookPayload = { ...base, hook_event_name: 'UserPromptSubmit', prompt }
  expect(translateHook(p)).toEqual([{ kind: 'event', body: { type: 'prompt', summary: 'run the tests', origin: 'glasses' } }])
})
