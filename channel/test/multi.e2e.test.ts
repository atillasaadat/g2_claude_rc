// Multi-session end to end: two real channel processes (two Claude Code
// sessions) share one pairing and one relay room, each with its own hook socket.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayClient, SecureChannel, type AnyEnvelope } from '@g2cc/protocol'
import { relayAuthToken, relayRoomUrl } from '@g2cc/protocol'
import { existsSync } from 'node:fs'
import { runHook } from './run-hook'
import { STOP_RESPONSE } from '../src/controller'
import { loadOrCreatePairing } from '../src/pairing-store'

const ROOT = join(import.meta.dir, '..', '..')
const A = 'aaaaaaaa-0000-0000-0000-000000000001'
const B = 'bbbbbbbb-0000-0000-0000-000000000002'
let tmp = ''
let home = ''
const procs: Array<ReturnType<typeof Bun.spawn>> = []
const channels: Record<string, ReturnType<typeof Bun.spawn<'pipe', 'ignore', 'ignore'>>> = {}
const received: AnyEnvelope[] = []
let glasses: SecureChannel<'glasses'>
let relay: RelayClient | null = null

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = s.port as number
  s.stop(true)
  return port
}

async function until(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

const hook = (sid: string, payload: Record<string, unknown>) => runHook(home, { session_id: sid, cwd: '/tmp/x', permission_mode: 'default', ...payload })

function spawnChannel(sid: string, project: string, relayUrl: string) {
  const p = Bun.spawn(['bun', 'server.ts'], {
    cwd: join(ROOT, 'channel'),
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, G2CC_HOME: home, G2CC_RELAY_URL: relayUrl, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PROJECT_DIR: project },
  })
  const send = (m: unknown) => {
    p.stdin.write(JSON.stringify(m) + '\n')
    p.stdin.flush()
  }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  procs.push(p)
  channels[sid] = p
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'g2cc-multi-'))
  home = join(tmp, 'home')
  const wranglerPort = freePort()
  const relayUrl = `ws://127.0.0.1:${wranglerPort}`
  procs.push(
    Bun.spawn(
      ['./node_modules/.bin/wrangler', 'dev', '--port', String(wranglerPort), '--ip', '127.0.0.1', '--persist-to', join(tmp, 'w'), '--show-interactive-dev-session=false', '--var', 'CONNECT_LIMIT_ENABLED:false'],
      { cwd: join(ROOT, 'relay'), stdout: 'ignore', stderr: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    ),
  )
  const end = Date.now() + 60_000
  while (Date.now() < end) {
    try {
      if ((await fetch(`http://127.0.0.1:${wranglerPort}/`)).ok) break
    } catch {}
    await Bun.sleep(300)
  }
  // Create the pairing once so both channels share the same key.
  const pairing = await loadOrCreatePairing(home, { relayUrl })
  spawnChannel(A, '/tmp/repo-a', relayUrl)
  spawnChannel(B, '/tmp/repo-b', relayUrl)

  glasses = await SecureChannel.create(pairing.key, 'glasses')
  relay = new RelayClient({
    url: relayRoomUrl(relayUrl, glasses.roomId, 'glasses', await relayAuthToken(pairing.key, glasses.roomId)),
    onFrame: async f => {
      const env = await glasses.open(f)
      if (env) received.push(env)
    },
  })
  relay.start()
  await until(() => new Set(received.filter(e => e.kind === 'session').map(e => e.sid)).size === 2, 'both sessions')
  await until(() => [A, B].every(s => existsSync(join(home, 'sessions', `${s}.sock`))), 'both sockets')
}, 120_000)

afterAll(() => {
  relay?.stop()
  for (const p of procs) p.kill()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('two sessions, each on its own socket', () => {
  test('both sessions announce themselves with their own names', () => {
    const names = Object.fromEntries(received.filter(e => e.kind === 'session').map(e => [e.sid, (e.body as { name: string }).name]))
    expect(names).toEqual({ [A]: 'repo-a', [B]: 'repo-b' })
  })

  test('each session’s hooks reach its own channel, tagged with the right session', async () => {
    received.length = 0
    await hook(A, { hook_event_name: 'UserPromptSubmit', prompt: 'task for A' })
    await hook(B, { hook_event_name: 'UserPromptSubmit', prompt: 'task for B' })
    await until(() => received.filter(e => e.kind === 'event').length >= 2, 'both prompts')
    const prompts = received.filter(e => e.kind === 'event').map(e => [e.sid, (e.body as { summary: string }).summary])
    expect(prompts).toContainEqual([A, 'task for A'])
    expect(prompts).toContainEqual([B, 'task for B'])
  })

  test('a stop aimed at B halts only B', async () => {
    relay!.send(await glasses.seal('stop', {}, { sid: B }))
    await until(() => received.some(e => e.sid === B && JSON.stringify(e.body).includes('Stop requested')), 'B acknowledges')
    const b = await hook(B, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } })
    expect(await b.json()).toEqual(STOP_RESPONSE)
    const a = await hook(A, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } })
    expect(await a.json()).toEqual({})
  })

  test('when A ends, its socket goes away, the glasses hear it ended, and B carries on', async () => {
    received.length = 0
    channels[A]!.stdin.end() // Claude Code closing stdin = session over
    await until(() => received.some(e => e.sid === A && e.kind === 'session' && e.body.state === 'ended'), 'A ended')
    await until(() => !existsSync(join(home, 'sessions', `${A}.sock`)), 'A socket removed')
    expect(await (await hook(A, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })).json()).toEqual({})
    await hook(B, { hook_event_name: 'UserPromptSubmit', prompt: 'after A left' })
    await until(() => received.some(e => e.sid === B && JSON.stringify(e.body).includes('after A left')), 'B prompt after A left')
  }, 30_000)
})
