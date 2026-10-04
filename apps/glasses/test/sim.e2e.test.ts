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
import { encodePairing, generateKey, RelayClient, relayAuthToken, relayRoomUrl, SecureChannel, toBase64Url, type AnyEnvelope, type Body } from '@g2cc/protocol'

const RUN = process.env.G2CC_SIM === '1'
const FAKE_TRANSCRIPT = 'Run the unit tests and tell me what failed.'
const APP = join(import.meta.dir, '..')
const ROOT = join(APP, '..', '..')
const ARTIFACTS = join(APP, 'test', 'artifacts')

type Frame = { header: string; timeline: string; overlay?: { name: string; content: string } }

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

async function send<K extends 'session' | 'event' | 'reply' | 'glance' | 'permission' | 'permission_resolved' | 'question'>(kind: K, body: Body<K>): Promise<void> {
  relay.send(await computer.seal(kind, body))
}

beforeAll(async () => {
  if (!RUN) return
  tmp = mkdtempSync(join(tmpdir(), 'g2cc-sim-'))

  const wranglerPort = freePort()
  procs.push(
    Bun.spawn(
      ['./node_modules/.bin/wrangler', 'dev', '--port', String(wranglerPort), '--ip', '127.0.0.1', '--persist-to', join(tmp, 'w'), '--show-interactive-dev-session=false', '--var', 'CONNECT_LIMIT_ENABLED:false'],
      { cwd: join(ROOT, 'relay'), stdout: 'ignore', stderr: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    ),
  )
  await waitFor(async () => (await fetch(`http://127.0.0.1:${wranglerPort}/`)).ok, 'relay')

  const vitePort = freePort()
  procs.push(Bun.spawn(['./node_modules/.bin/vite', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { cwd: APP, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, VITE_G2CC_FAKE_STT: FAKE_TRANSCRIPT, VITE_STT_API_KEY: '' } }))
  await waitFor(async () => (await fetch(`http://127.0.0.1:${vitePort}/`)).ok, 'vite')

  const key = generateKey()
  const pairing = await encodePairing({ relayUrl: `ws://127.0.0.1:${wranglerPort}`, key })
  computer = await SecureChannel.create(key, 'computer')
  relay = new RelayClient({
    url: relayRoomUrl(`ws://127.0.0.1:${wranglerPort}`, computer.roomId, 'computer', await relayAuthToken(key, computer.roomId)),
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
  // The launcher spawns the native simulator window as a separate process that
  // outlives it; close that window by its unique automation port.
  // '--' ends pkill's options, since the pattern itself starts with dashes.
  if (automation) Bun.spawnSync(['pkill', '-f', '--', `--automation-port ${new URL(automation).port}`])
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

const ov = (f: Frame) => f.overlay?.content ?? ''

describe.skipIf(!RUN)('glasses app in the simulator', () => {
  test('pairs from the URL fragment and shows the computer as connected', async () => {
    await send('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'idle', mode: 'auto' })
    const f = await frameWhere(f => f.header.startsWith('● g2cc-sandbox · idle') && f.header.endsWith('auto'), 'connected header')
    expect(f.timeline).toContain('No activity yet')
  })

  test('the timeline shows merged tool lines, glance, and animated working dots', async () => {
    await send('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'working', mode: 'auto' })
    await send('event', { type: 'prompt', summary: 'run the tests', origin: 'local' })
    await send('event', { type: 'tool_start', tool: 'Bash', summary: 'bun test' })
    await send('event', { type: 'tool_end', tool: 'Bash', summary: 'ok' })
    await send('event', { type: 'tool_start', tool: 'Edit', summary: 'src/state.ts' })
    await send('glance', { text: 'Fixing the reducer' })
    const f = await frameWhere(f => f.timeline.includes('» Fixing the reducer'), 'timeline frame')
    expect(f.timeline.split('\n')).toEqual(['> run the tests', '• Bash: bun test → ok', '▶ Edit: src/state.ts', '» Fixing the reducer'])
    await frameWhere(f => f.header.includes('working ··'), 'dots advanced')
    await Bun.sleep(300)
    const png = await screenshot('timeline')
    expect(litPixels(png, 0, 35)).toBeGreaterThan(50)
    expect(litPixels(png, 38, 288)).toBeGreaterThan(200)
  })

  test('a long reply lands on its first line, and swipes scroll through it', async () => {
    await send('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'idle', mode: 'auto' })
    const text = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}: the timeline scrolls continuously.`).join('\n')
    await send('reply', { text })
    const first = await frameWhere(f => f.timeline.split('\n')[0] === 'Line 1: the timeline scrolls continuously.', 'reply start at the top')
    expect(first.header).toMatch(/▼ \d+ newer$/)
    await screenshot('reply')
    await input('down')
    await frameWhere(f => f.timeline.split('\n')[0] === 'Line 4: the timeline scrolls continuously.', 'scrolled down 3 lines')
    await input('double_click') // jumps to live; never opens the exit dialog
    await frameWhere(f => f.timeline.split('\n').at(-1) === 'Line 14: the timeline scrolls continuously.' && f.header.endsWith('auto'), 'back to live')
    // A second double tap at live does nothing (no exit dialog): the app still responds.
    await input('double_click')
    await Bun.sleep(500)
    await input('up')
    await frameWhere(f => /▼ \d+ newer$/.test(f.header), 'still responsive after a second double tap')
    await input('double_click')
    await frameWhere(f => f.header.endsWith('auto'), 'live again')
  })

  test('tap opens the menu box, and Stop sends a stop to the computer', async () => {
    await send('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'working', mode: 'auto' })
    await frameWhere(f => f.header.includes('working'), 'working header')
    await input('click')
    const menu = await frameWhere(f => f.overlay?.name === 'menu', 'menu')
    expect(ov(menu).split('\n')).toEqual(['▶ Talk', '   Stop Claude', '   Display off', '   End session'])
    await Bun.sleep(600) // let the fade finish before the screenshot
    await screenshot('menu')
    await input('down')
    await frameWhere(f => ov(f).includes('▶ Stop Claude'), 'stop highlighted')
    await input('click')
    await frameWhere(f => f.header.includes('■ stopping…'), 'stopping header')
    await waitFor(async () => inbound.some(e => e.kind === 'stop'), 'stop at the computer', 5_000)
    await send('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'stopped', mode: 'auto' })
    await frameWhere(f => f.header.startsWith('● g2cc-sandbox · stopped'), 'stopped header')
  })

  test('a permission card overlays the timeline; Allow sends the verdict; resolved cards close', async () => {
    await send('permission', {
      request_id: 'wokkv',
      tool_name: 'Bash',
      description: 'Create empty test file',
      input_preview: '{ "command": "touch perm-test-3.txt", "description": "Create empty test file" }',
    })
    const card = await frameWhere(f => f.overlay?.name === 'card', 'permission card')
    expect(ov(card).split('\n')[0]).toBe('Allow Bash?')
    expect(ov(card)).toContain('touch perm-test-3.txt')
    expect(ov(card).split('\n').at(-1)).toMatch(/▶ Deny$/)
    await Bun.sleep(700) // past the input guard and the fade
    await screenshot('permission')
    await input('up')
    await frameWhere(f => ov(f).includes('▶ Allow'), 'allow highlighted')
    await input('click')
    await waitFor(async () => inbound.some(e => e.kind === 'verdict'), 'verdict at the computer', 5_000)
    expect(inbound.find(e => e.kind === 'verdict')!.body).toEqual({ request_id: 'wokkv', behavior: 'allow' })
    await frameWhere(f => !f.overlay, 'card closed')

    await send('permission', { request_id: 'fghij', tool_name: 'Write', description: 'Write a file', input_preview: '{}' })
    await frameWhere(f => ov(f).startsWith('Allow Write?'), 'second card')
    await send('permission_resolved', { request_id: 'fghij' })
    await frameWhere(f => !f.overlay, 'closed by resolution')
  })

  test('voice: the box fills in live, then review and send a prompt to the computer', async () => {
    await send('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'idle', mode: 'auto' })
    await frameWhere(f => f.header.includes('idle') && !f.overlay, 'idle')
    await input('click')
    await frameWhere(f => ov(f).startsWith('▶ Talk'), 'menu with Talk')
    await input('click')
    await frameWhere(f => f.overlay?.name === 'voice' && / Listening/.test(ov(f)), 'listening')
    await Bun.sleep(800) // the rebuild reaches the framebuffer a little after the frame is logged
    await screenshot('listening')
    await input('click') // done speaking
    const review = await frameWhere(f => ov(f).startsWith('Send to Claude?'), 'review')
    expect(ov(review).split('\n')[1]).toBe(FAKE_TRANSCRIPT)
    await Bun.sleep(600)
    await screenshot('voice-review')
    await input('click')
    await waitFor(async () => inbound.some(e => e.kind === 'prompt'), 'prompt at the computer', 5_000)
    expect(inbound.find(e => e.kind === 'prompt')!.body).toEqual({ text: FAKE_TRANSCRIPT })
    await frameWhere(f => !f.overlay, 'back to the timeline')
  })

  test('Display off blanks the glasses, and a reply (or any gesture) brings them back', async () => {
    await send('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'working', mode: 'auto' })
    await frameWhere(f => f.header.includes('working') && !f.overlay, 'working')
    await input('click')
    await frameWhere(f => ov(f).includes('Display off'), 'menu with Display off')
    for (let i = 0; i < 2; i++) await input('down')
    await frameWhere(f => ov(f).includes('▶ Display off'), 'Display off highlighted')
    await input('click')
    await frameWhere(f => f.header === '' && f.timeline === '' && !f.overlay, 'display off')
    await Bun.sleep(400)
    expect(litPixels(await screenshot('display-off'), 0, 288)).toBe(0)
    // A gesture only wakes it: the menu does not open.
    await input('click')
    const awake = await frameWhere(f => f.header.includes('g2cc-sandbox'), 'awake again')
    expect(awake.overlay).toBeUndefined()
    // Off again, then a reply wakes it.
    await input('click')
    await frameWhere(f => ov(f).includes('Display off'), 'menu again')
    for (let i = 0; i < 2; i++) await input('down')
    await input('click')
    await frameWhere(f => f.header === '' && f.timeline === '', 'off again')
    await send('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'idle', mode: 'auto' })
    await send('reply', { text: 'All done.' })
    await frameWhere(f => f.timeline.includes('All done.'), 'woken by the reply')
  })

  test('a question card shows the options, and the chosen answer reaches the computer', async () => {
    await send('question', { question_id: 'q0000abcd', question: 'Which branch should I deploy?', options: ['main', 'dev', 'release'] })
    const card = await frameWhere(f => f.overlay?.name === 'question', 'question card')
    expect(ov(card).split('\n')).toEqual(['Which branch should I deploy?', '', '▶ main', '   dev', '   release'])
    await Bun.sleep(700)
    await screenshot('question')
    await input('down')
    await frameWhere(f => ov(f).includes('▶ dev'), 'dev highlighted')
    await input('click')
    await waitFor(async () => inbound.some(e => e.kind === 'answer'), 'answer at the computer', 5_000)
    expect(inbound.find(e => e.kind === 'answer')!.body).toEqual({ question_id: 'q0000abcd', choice: 'dev' })
  })
})
