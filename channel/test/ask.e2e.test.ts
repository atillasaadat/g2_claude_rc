// End-to-end: ask in a session whose client shows dialogs (the terminal, and
// the web view through Remote Control). The real channel process, the relay
// under `wrangler dev`, and a glasses-side client; the test plays Claude Code.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayClient, relayAuthToken, relayRoomUrl, SecureChannel, type AnyEnvelope } from '@g2cc/protocol'
import { loadOrCreatePairing } from '../src/pairing-store'

const ROOT = join(import.meta.dir, '..', '..')
const SESSION = '22222222-3333-4444-5555-666666666666'
let tmp = ''
let home = ''
const procs: Array<ReturnType<typeof Bun.spawn>> = []
let channel: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>> | null = null
let glassesRelay: RelayClient | null = null
let glasses: SecureChannel<'glasses'>
const received: AnyEnvelope[] = []
const lines: string[] = []

type Msg = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: { content: Array<{ text: string }> } }
const out = (): Msg[] => lines.map(l => JSON.parse(l) as Msg)

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = s.port as number
  s.stop(true)
  return port
}

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out; glasses got ${JSON.stringify(received.map(e => e.kind))}`)
    await Bun.sleep(20)
  }
}

function send(msg: unknown): void {
  channel!.stdin.write(JSON.stringify(msg) + '\n')
  channel!.stdin.flush()
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<void> {
  const dec = new TextDecoder()
  let buf = ''
  const reader = stream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  }
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'g2cc-ask-'))
  const port = freePort()
  const relayUrl = `ws://127.0.0.1:${port}`
  procs.push(
    Bun.spawn(
      ['./node_modules/.bin/wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', join(tmp, 'wrangler'), '--show-interactive-dev-session=false', '--var', 'CONNECT_LIMIT_ENABLED:false'],
      { cwd: join(ROOT, 'relay'), stdout: 'ignore', stderr: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    ),
  )
  const up = Date.now() + 60_000
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/`)
      break
    } catch {
      if (Date.now() > up) throw new Error('relay did not come up')
      await Bun.sleep(300)
    }
  }
  home = join(tmp, 'home')
  channel = Bun.spawn(['bun', 'server.ts'], {
    cwd: join(ROOT, 'channel'),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, G2CC_HOME: home, G2CC_RELAY_URL: relayUrl, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: '/tmp/demo-repo' },
  })
  procs.push(channel)
  void collect(channel.stdout)
  // Like Claude Code: this client can show dialogs.
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'test', version: '0' } } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const end = Date.now() + 15_000
  while (!existsSync(join(home, 'sessions', `${SESSION}.sock`))) {
    if (Date.now() > end) throw new Error('channel did not start')
    await Bun.sleep(100)
  }
  const pairing = await loadOrCreatePairing(home)
  glasses = await SecureChannel.create(pairing.key, 'glasses')
  glassesRelay = new RelayClient({
    url: relayRoomUrl(relayUrl, glasses.roomId, 'glasses', await relayAuthToken(pairing.key, glasses.roomId)),
    onFrame: async f => {
      const env = await glasses.open(f)
      if (env) received.push(env)
    },
  })
  glassesRelay.start()
  await until(() => received.some(e => e.kind === 'session'), 15_000)
}, 90_000)

afterAll(() => {
  glassesRelay?.stop()
  for (const p of procs) p.kill()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

/** Calls ask and waits for both the glasses card and the dialog. */
async function ask(id: number, question: string): Promise<{ questionId: string; dialog: Msg }> {
  send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ask', arguments: { question, options: ['main', 'dev'] } } })
  await until(() => received.some(e => e.kind === 'question' && (e.body as { question: string }).question === question))
  await until(() => out().some(m => m.method === 'elicitation/create' && String(m.params?.message).startsWith(question)))
  const card = received.find(e => e.kind === 'question' && (e.body as { question: string }).question === question)!
  return { questionId: (card.body as { question_id: string }).question_id, dialog: out().find(m => m.method === 'elicitation/create' && String(m.params?.message).startsWith(question))! }
}
const result = (id: number) => out().find(m => m.id === id && m.result)?.result?.content[0]?.text

describe('ask answered from anywhere', () => {
  test('the dialog offers the options and a free-text answer; words typed there answer and clear the card', async () => {
    const { questionId, dialog } = await ask(10, 'Which branch?')
    const schema = dialog.params!.requestedSchema as { properties: Record<string, { enum?: string[] }>; required?: string[] }
    expect(schema.properties.choice!.enum).toEqual(['main', 'dev'])
    expect(schema.properties.other).toBeDefined()
    expect(schema.required ?? []).toEqual([])
    send({ jsonrpc: '2.0', id: dialog.id, result: { action: 'accept', content: { other: 'a new branch called fix' } } })
    await until(() => result(10) !== undefined)
    expect(result(10)).toContain('"a new branch called fix"')
    await until(() => received.some(e => e.kind === 'question_resolved' && (e.body as { question_id: string }).question_id === questionId))
  })

  test('a choice made in the dialog (terminal or web view) answers and clears the card', async () => {
    const { questionId, dialog } = await ask(11, 'Merge now?')
    send({ jsonrpc: '2.0', id: dialog.id, result: { action: 'accept', content: { choice: 'dev' } } })
    await until(() => result(11) !== undefined)
    expect(result(11)).toContain('The user chose "dev"')
    await until(() => received.some(e => e.kind === 'question_resolved' && (e.body as { question_id: string }).question_id === questionId))
  })

  test('a glasses answer returns at once and closes the dialog', async () => {
    const { questionId, dialog } = await ask(12, 'Deploy?')
    glassesRelay!.send(await glasses.seal('answer', { question_id: questionId, choice: 'main' }, { sid: SESSION }))
    await until(() => result(12) !== undefined)
    expect(result(12)).toBe('The user chose "main" (answered on the glasses).')
    await until(() => out().some(m => m.method === 'notifications/cancelled' && m.params?.requestId === dialog.id))
  })
})
