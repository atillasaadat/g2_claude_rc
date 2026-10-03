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
import { RelayClient } from '../src/relay-client'

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
let glassesRelay: RelayClient | null = null

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
  const glasses = await SecureChannel.create(pairing.key, 'glasses')
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

  test('the MCP side advertises the channel capability and instructions', async () => {
    const reader = channel!.stdout.getReader()
    const { value } = await reader.read()
    reader.releaseLock()
    const first = JSON.parse(new TextDecoder().decode(value).split('\n')[0]!)
    expect(first.result.capabilities.experimental['claude/channel']).toEqual({})
    expect(first.result.instructions).toContain('glance')
  })
})
