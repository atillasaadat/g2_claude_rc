// Simulator end-to-end: real glasses app in the Even Hub simulator, real relay
// (wrangler dev), and this test playing the computer side.
//
// Opens a GUI window, so it only runs when asked:
//   G2CC_SIM=1 bun test test/sim.e2e.test.ts
// Screenshots land in apps/glasses/test/artifacts/.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { encodePairing, generateKey, RelayClient, SecureChannel, toBase64Url, type AnyEnvelope, type Body } from '@g2cc/protocol'

const RUN = process.env.G2CC_SIM === '1'
const APP = join(import.meta.dir, '..')
const ROOT = join(APP, '..', '..')
const ARTIFACTS = join(APP, 'test', 'artifacts')

type Frame = { header: string; body: string }

const procs: Array<ReturnType<typeof Bun.spawn>> = []
let tmp = ''
let automation = ''
let computer: SecureChannel<'computer'>
let relay: RelayClient
let lastConsoleId = -1
const inbound: AnyEnvelope[] = []

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = s.port as number
  s.stop(true)
  return port
}

async function waitFor(fn: () => Promise<boolean>, what: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await fn()) return
    } catch {}
    await Bun.sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function consoleSince(): Promise<Array<{ id: number; message: string }>> {
  const q = lastConsoleId >= 0 ? `?since_id=${lastConsoleId}` : ''
  const { entries } = (await (await fetch(`${automation}/api/console${q}`)).json()) as { entries: Array<{ id: number; message: string }> }
  for (const e of entries) lastConsoleId = Math.max(lastConsoleId, e.id)
  return entries
}

/** Waits until the app logs a frame matching `pred`, returns it. */
async function frameWhere(pred: (f: Frame) => boolean, what: string, ms = 10_000): Promise<Frame> {
  let found: Frame | null = null
  await waitFor(
    async () => {
      for (const e of await consoleSince()) {
        const m = /\[g2cc\] frame (.*)$/.exec(e.message)
        if (!m?.[1]) continue
        const f = JSON.parse(m[1]) as Frame
        if (pred(f)) found = f
      }
      return found !== null
    },
    what,
    ms,
  )
  return found!
}

async function input(action: 'up' | 'down' | 'click' | 'double_click'): Promise<void> {
  await fetch(`${automation}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
}

async function screenshot(name: string): Promise<Uint8Array> {
  const png = new Uint8Array(await (await fetch(`${automation}/api/screenshot/glasses`)).arrayBuffer())
  mkdirSync(ARTIFACTS, { recursive: true })
  await Bun.write(join(ARTIFACTS, `${name}.png`), png)
  return png
}

/** Counts opaque (lit) pixels in rows [y0, y1). Background is alpha 0, text alpha 255. */
function litPixels(png: Uint8Array, y0: number, y1: number): number {
  const img = PNG.sync.read(Buffer.from(png))
  let n = 0
  for (let y = y0; y < Math.min(y1, img.height); y++) {
    for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4 + 3]! > 0) n++
  }
  return n
}

async function send<K extends 'session' | 'event' | 'reply' | 'glance' | 'permission' | 'permission_resolved'>(kind: K, body: Body<K>): Promise<void> {
  relay.send(await computer.seal(kind, body))
}

beforeAll(async () => {
  if (!RUN) return
  tmp = mkdtempSync(join(tmpdir(), 'g2cc-sim-'))

  const wranglerPort = freePort()
  procs.push(
    Bun.spawn(
      ['./node_modules/.bin/wrangler', 'dev', '--port', String(wranglerPort), '--ip', '127.0.0.1', '--persist-to', join(tmp, 'w'), '--show-interactive-dev-session=false'],
      { cwd: join(ROOT, 'relay'), stdout: 'ignore', stderr: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    ),
  )
  await waitFor(async () => (await fetch(`http://127.0.0.1:${wranglerPort}/`)).ok, 'relay')

  const vitePort = freePort()
  procs.push(Bun.spawn(['./node_modules/.bin/vite', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { cwd: APP, stdout: 'ignore', stderr: 'ignore' }))
  await waitFor(async () => (await fetch(`http://127.0.0.1:${vitePort}/`)).ok, 'vite')

  const key = generateKey()
  const pairing = await encodePairing({ relayUrl: `ws://127.0.0.1:${wranglerPort}`, key })
  computer = await SecureChannel.create(key, 'computer')
  relay = new RelayClient({
    url: `ws://127.0.0.1:${wranglerPort}/v1/room/${computer.roomId}?role=computer`,
    onFrame: async f => {
      const env = await computer.open(f)
      if (env) inbound.push(env)
    },
  })
  relay.start()

  const autoPort = freePort()
  automation = `http://127.0.0.1:${autoPort}`
  const url = `http://127.0.0.1:${vitePort}/#pair=${toBase64Url(new TextEncoder().encode(pairing))}`
  procs.push(Bun.spawn(['./node_modules/.bin/evenhub-simulator', '--no-glow', '--automation-port', String(autoPort), url], { cwd: APP, stdout: 'ignore', stderr: 'ignore' }))
  await waitFor(async () => (await (await fetch(`${automation}/api/ping`)).text()) === 'pong', 'simulator')
  await waitFor(async () => (await consoleSince()).some(e => e.message.includes('[g2cc] ready')), 'app ready', 30_000)
}, 120_000)

afterAll(() => {
  relay?.stop()
  for (const p of procs.reverse()) p.kill()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe.skipIf(!RUN)('glasses app in the simulator', () => {
  test('pairs from the URL fragment and shows the computer as connected', async () => {
    await send('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'idle', mode: 'auto' })
    const f = await frameWhere(f => f.header === '● g2cc-sandbox · idle · auto', 'connected header')
    expect(f.body).toContain('No activity yet')
  })

  test('shows the live feed with merged tool lines and glance', async () => {
    await send('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'working', mode: 'auto' })
    await send('event', { type: 'prompt', summary: 'run the tests', origin: 'local' })
    await send('event', { type: 'tool_start', tool: 'Bash', summary: 'bun test' })
    await send('event', { type: 'tool_end', tool: 'Bash', summary: 'ok' })
    await send('event', { type: 'tool_start', tool: 'Edit', summary: 'src/state.ts' })
    await send('glance', { text: 'Fixing the reducer' })
    const f = await frameWhere(f => f.body.includes('Fixing the reducer') && f.body.includes('▶ Edit'), 'feed frame')
    expect(f.header).toBe('● g2cc-sandbox · working · auto')
    expect(f.body.split('\n').slice(0, 3)).toEqual(['> run the tests', '• Bash: bun test → ok', '▶ Edit: src/state.ts'])

    await Bun.sleep(400) // let the debounced render reach the framebuffer
    const png = await screenshot('feed')
    expect(litPixels(png, 0, 35)).toBeGreaterThan(50)
    expect(litPixels(png, 35, 288)).toBeGreaterThan(200)
  })

  test('a fresh reply opens the paginated reply view, which pages and goes back', async () => {
    const text = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}: the reducer now merges tool start and end events.`).join('\n')
    await send('reply', { text })
    const first = await frameWhere(f => f.header.startsWith('Reply 1/'), 'reply page 1')
    expect(first.body.split('\n')[0]).toBe('Line 1: the reducer now merges tool start and end events.')
    await screenshot('reply')

    await input('down')
    const second = await frameWhere(f => f.header.startsWith('Reply 2/'), 'reply page 2')
    expect(second.body).toContain('Line 1')

    await input('double_click')
    const back = await frameWhere(f => f.header.startsWith('●'), 'back to feed')
    expect(back.body).toContain('↓ reply')
  })

  test('scrolling up shows older events', async () => {
    for (let i = 0; i < 6; i++) await send('event', { type: 'notify', summary: `notice ${i}` })
    await frameWhere(f => f.body.includes('notice 5'), 'newest notices')
    await input('up')
    const f = await frameWhere(f => f.body.includes('1 newer'), 'scrolled feed')
    expect(f.body).not.toContain('notice 5')
  })

  test('feed tap opens the menu, and choosing Stop sends a stop to the computer', async () => {
    await send('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'working', mode: 'auto' })
    await frameWhere(f => f.header.includes('working'), 'working header')
    await input('click')
    const menu = await frameWhere(f => f.header.startsWith('Menu'), 'menu')
    expect(menu.body.split('\n')[0]).toBe('▶ Talk (coming soon)')
    await screenshot('menu')

    await input('down')
    await frameWhere(f => f.body.startsWith('   Talk') && f.body.includes('▶ Stop Claude'), 'stop highlighted')
    await input('click')
    const stopping = await frameWhere(f => f.header.includes('■ stopping…'), 'stopping header')
    expect(stopping.header).toContain('g2cc-sandbox')
    await waitFor(async () => inbound.some(e => e.kind === 'stop'), 'stop at the computer', 5_000)

    await send('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'stopped', mode: 'auto' })
    const stopped = await frameWhere(f => f.header === '● g2cc-sandbox · stopped · auto', 'stopped header')
    expect(stopped.header).not.toContain('stopping')
  })

  test('a permission card appears, Allow sends the verdict, and resolved cards close', async () => {
    await send('permission', {
      request_id: 'wokkv',
      tool_name: 'Bash',
      description: 'Create empty test file',
      input_preview: '{ "command": "touch perm-test-3.txt", "description": "Create empty test file" }',
    })
    const card = await frameWhere(f => f.header === 'Allow Bash?', 'permission card')
    expect(card.body.split('\n').at(-1)).toBe('▶ Deny')
    expect(card.body).toContain('touch perm-test-3.txt')
    await screenshot('permission')

    await Bun.sleep(700) // past the input guard
    await input('up')
    await frameWhere(f => f.header === 'Allow Bash?' && f.body.includes('▶ Allow'), 'allow highlighted')
    await input('click')
    await waitFor(async () => inbound.some(e => e.kind === 'verdict'), 'verdict at the computer', 5_000)
    expect(inbound.find(e => e.kind === 'verdict')!.body).toEqual({ request_id: 'wokkv', behavior: 'allow' })
    await frameWhere(f => f.header.startsWith('●'), 'back to feed')

    // Answered elsewhere: the channel's permission_resolved closes the card.
    await send('permission', { request_id: 'fghij', tool_name: 'Write', description: 'Write a file', input_preview: '{}' })
    await frameWhere(f => f.header === 'Allow Write?', 'second card')
    await send('permission_resolved', { request_id: 'fghij' })
    await frameWhere(f => f.header.startsWith('●'), 'card closed by resolution')
  })
})
