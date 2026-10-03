// End-to-end: the real channel process (as Claude Code spawns it) feeds hook
// events through `wrangler dev` to a glasses-side client. Phase 2 "done" check,
// minus the live Claude Code session.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecureChannel, type AnyEnvelope } from '@g2cc/protocol'
import { relaySocketUrl } from '../src/config'
import { loadOrCreatePairing } from '../src/pairing-store'
import { RelayClient } from '@g2cc/protocol'
import { STOP_RESPONSE } from '../src/controller'

const ROOT = join(import.meta.dir, '..', '..')
const SESSION = '11111111-2222-3333-4444-555555555555'
let tmp = ''
let relayUrl = ''
let hookUrl = ''
const procs: Array<ReturnType<typeof Bun.spawn>> = []
let channel: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>> | null = null

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = s.port as number
  s.stop(true)
  return port
}

async function waitFor(url: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      await fetch(url)
      return
    } catch {
      await Bun.sleep(300)
    }
  }
  throw new Error(`${url} did not come up`)
}

const received: AnyEnvelope[] = []
const stdoutLines: string[] = []

async function collectStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
  const dec = new TextDecoder()
  let buf = ''
  const reader = stream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      stdoutLines.push(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  }
}
const mcpOut = () => stdoutLines.map(l => JSON.parse(l) as Record<string, unknown>)
let glassesRelay: RelayClient | null = null
let glasses: SecureChannel<'glasses'>

async function until(pred: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(received.map(e => e.kind))}`)
    await Bun.sleep(20)
  }
}

function mcpSend(msg: unknown): void {
  channel!.stdin.write(JSON.stringify(msg) + '\n')
  channel!.stdin.flush()
}

const hook = (payload: Record<string, unknown>) =>
  fetch(hookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: SESSION, cwd: '/tmp/demo-repo', permission_mode: 'default', ...payload }),
  })

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'g2cc-chan-'))
  const wranglerPort = freePort()
  relayUrl = `ws://127.0.0.1:${wranglerPort}`
  procs.push(
    Bun.spawn(
      ['./node_modules/.bin/wrangler', 'dev', '--port', String(wranglerPort), '--ip', '127.0.0.1', '--persist-to', join(tmp, 'wrangler'), '--show-interactive-dev-session=false'],
      { cwd: join(ROOT, 'relay'), stdout: 'ignore', stderr: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    ),
  )
  await waitFor(`http://127.0.0.1:${wranglerPort}/`)

  const hookPort = freePort()
  hookUrl = `http://127.0.0.1:${hookPort}/hook`
  const home = join(tmp, 'home')
  channel = Bun.spawn(['bun', 'server.ts'], {
    cwd: join(ROOT, 'channel'),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      G2CC_HOME: home,
      G2CC_PORT: String(hookPort),
      G2CC_RELAY_URL: relayUrl,
      CLAUDE_CODE_SESSION_ID: SESSION,
      CLAUDE_PROJECT_DIR: '/tmp/demo-repo',
    },
  })
  procs.push(channel)
  void collectStdout(channel.stdout)
  mcpSend({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
  mcpSend({ jsonrpc: '2.0', method: 'notifications/initialized' })

  // Wait for the channel to create the pairing and bind the hook port.
  const end = Date.now() + 15_000
  for (;;) {
    try {
      if ((await fetch(hookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).ok) break
    } catch {}
    if (Date.now() > end) throw new Error('channel did not start')
    await Bun.sleep(100)
  }

  const pairing = await loadOrCreatePairing(home)
  glasses = await SecureChannel.create(pairing.key, 'glasses')
  glassesRelay = new RelayClient({
    url: relaySocketUrl(relayUrl, glasses.roomId, 'glasses'),
    onFrame: async f => {
      const env = await glasses.open(f)
      if (env) received.push(env)
    },
  })
  glassesRelay.start()
}, 90_000)

afterAll(() => {
  glassesRelay?.stop()
  for (const p of procs) p.kill()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('channel feed end to end', () => {
  test('a joining glasses client gets the session header', async () => {
    await until(() => received.some(e => e.kind === 'session'))
    const s = received.find(e => e.kind === 'session')!
    expect(s.body).toMatchObject({ name: 'demo-repo', state: 'idle' })
    expect(s.sid).toBe(SESSION)
  })

  test('a turn streams prompt, tools, state and reply, in order and redacted', async () => {
    received.length = 0
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'deploy it' })
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer supersecret123" x' } })
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'curl' }, tool_response: { stdout: 'ok', stderr: '', interrupted: false } })
    await hook({ hook_event_name: 'Stop', last_assistant_message: 'Deployed. Token was gsk_abcdefghijklmnopqrstuvwxyz123.' })

    await until(() => received.some(e => e.kind === 'reply'))
    await until(() => received.filter(e => e.kind === 'session').length >= 2)
    const kinds = received.map(e => (e.kind === 'event' ? e.body.type : e.kind))
    expect(kinds).toEqual(['prompt', 'session', 'tool_start', 'tool_end', 'reply', 'session'])

    const all = JSON.stringify(received)
    expect(all).not.toContain('supersecret123')
    expect(all).not.toContain('gsk_abcdefghijklmnopqrstuvwxyz123')
    expect(received.filter(e => e.kind === 'session').map(e => (e.body as { state: string }).state)).toEqual(['working', 'idle'])
  })

  test('hooks from other sessions are ignored', async () => {
    received.length = 0
    await fetch(hookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'someone-else', hook_event_name: 'UserPromptSubmit', prompt: 'not mine' }),
    })
    await Bun.sleep(500)
    expect(received).toEqual([])
  })

  test('the glance tool reaches the glasses', async () => {
    received.length = 0
    mcpSend({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'glance', arguments: { text: 'Deployed v2, all green' } } })
    await until(() => received.some(e => e.kind === 'glance'))
    expect(received.find(e => e.kind === 'glance')!.body).toEqual({ text: 'Deployed v2, all green' })
  })

  test('stop from the glasses halts the next tool call', async () => {
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'long task' })
    received.length = 0
    glassesRelay!.send(await glasses.seal('stop', {}, { sid: SESSION }))
    await until(() => JSON.stringify(received).includes('Stop requested'))

    const res = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sleep 9' } })
    expect(await res.json()).toEqual(STOP_RESPONSE)
    await until(() => received.some(e => e.kind === 'session' && e.body.state === 'stopped'))

    // The next prompt clears it.
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'carry on' })
    const next = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a' } })
    expect(await next.json()).toEqual({})
  })

  test('a confirmed voice prompt is injected as a channel event', async () => {
    glassesRelay!.send(await glasses.seal('prompt', { text: 'run the unit tests' }, { sid: SESSION }))
    const isChannel = (m: Record<string, unknown>) => m.method === 'notifications/claude/channel'
    await until(() => mcpOut().some(isChannel))
    expect(mcpOut().find(isChannel)!.params).toEqual({ content: 'run the unit tests', meta: { source_kind: 'voice' } })
  })

  test('ask shows a question on the glasses and the chosen answer returns as a channel event', async () => {
    received.length = 0
    mcpSend({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask', arguments: { question: 'Which branch?', options: ['main', 'dev'] } } })
    await until(() => received.some(e => e.kind === 'question'))
    const q = received.find(e => e.kind === 'question')!.body as { question_id: string; question: string; options: string[] }
    expect(q).toMatchObject({ question: 'Which branch?', options: ['main', 'dev'] })
    const result = mcpOut().find(m => m.id === 3) as { result: { content: Array<{ text: string }> } }
    expect(result.result.content[0]!.text).toContain(q.question_id)

    glassesRelay!.send(await glasses.seal('answer', { question_id: q.question_id, choice: 'dev' }, { sid: SESSION }))
    const isAnswer = (m: Record<string, unknown>) =>
      m.method === 'notifications/claude/channel' && (m.params as { meta?: { question_id?: string } }).meta?.question_id === q.question_id
    await until(() => mcpOut().some(isAnswer))
    expect(mcpOut().find(isAnswer)!.params).toEqual({
      content: 'The user answered your question "Which branch?": dev',
      meta: { question_id: q.question_id, source_kind: 'answer' },
    })
  })

  test('AskUserQuestion is redirected while the glasses are connected', async () => {
    const res = await hook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: {} })
    const body = (await res.json()) as { hookSpecificOutput?: { permissionDecision?: string } }
    expect(body.hookSpecificOutput?.permissionDecision).toBe('deny')
  })

  test('the MCP side advertises the channel and permission capabilities and instructions', async () => {
    const init = mcpOut().find(m => m.id === 1) as { result: { capabilities: { experimental: Record<string, unknown> }; instructions: string } }
    expect(init.result.capabilities.experimental['claude/channel']).toEqual({})
    expect(init.result.capabilities.experimental['claude/channel/permission']).toEqual({})
    expect(init.result.instructions).toContain('glance')
    expect(init.result.instructions).toContain('transcription errors')
  })

  test('a permission request reaches the glasses, and Allow goes back to Claude Code', async () => {
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'make a file' })
    received.length = 0
    mcpSend({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel/permission_request',
      params: { request_id: 'wokkv', tool_name: 'Bash', description: 'Create empty test file', input_preview: '{ "command": "touch x" }' },
    })
    await until(() => received.some(e => e.kind === 'permission'))
    const card = received.find(e => e.kind === 'permission')!
    expect(card.body).toEqual({ request_id: 'wokkv', tool_name: 'Bash', description: 'Create empty test file', input_preview: '{ "command": "touch x" }' })

    glassesRelay!.send(await glasses.seal('verdict', { request_id: 'wokkv', behavior: 'allow' }, { sid: SESSION }))
    const isVerdict = (m: Record<string, unknown>) => m.method === 'notifications/claude/channel/permission'
    await until(() => mcpOut().some(isVerdict))
    expect(mcpOut().find(isVerdict)!.params).toEqual({ request_id: 'wokkv', behavior: 'allow' })
    await until(() => received.some(e => e.kind === 'permission_resolved'))

    // A replayed verdict is never relayed twice.
    glassesRelay!.send(await glasses.seal('verdict', { request_id: 'wokkv', behavior: 'deny' }, { sid: SESSION }))
    await Bun.sleep(500)
    expect(mcpOut().filter(isVerdict)).toHaveLength(1)
  })
})
