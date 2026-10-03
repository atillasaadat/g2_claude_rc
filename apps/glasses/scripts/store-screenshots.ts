#!/usr/bin/env bun
// Screenshots for the Even Hub listing: the real app in the simulator, fed a
// scripted session through a local relay, captured screen by screen.
//
//   cd apps/glasses && bun scripts/store-screenshots.ts
//
// Writes build/store-screenshots/<n>-<screen>.png at 576x288 and at 2x, with
// a transparent background (the glasses draw lit pixels only). Opens a simulator window and closes it.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { encodePairing, generateKey, RelayClient, relayAuthToken, relayRoomUrl, SecureChannel, toBase64Url, type Body } from '@g2cc/protocol'

const APP = join(import.meta.dir, '..')
const ROOT = join(APP, '..', '..')
const OUT = join(ROOT, 'build', 'store-screenshots')
const TRANSCRIPT = 'Open a pull request with a short summary of the forecast change.'
const SID = 'store-shots'

const procs: Array<ReturnType<typeof Bun.spawn>> = []
let automation = ''

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

let lastConsoleId = -1
async function sawLog(needle: string | RegExp, ms = 10_000): Promise<void> {
  await waitFor(async () => {
    const q = lastConsoleId >= 0 ? `?since_id=${lastConsoleId}` : ''
    const { entries } = (await (await fetch(`${automation}/api/console${q}`)).json()) as { entries: Array<{ id: number; message: string }> }
    let hit = false
    for (const e of entries) {
      lastConsoleId = Math.max(lastConsoleId, e.id)
      if (typeof needle === 'string' ? e.message.includes(needle) : needle.test(e.message)) hit = true
    }
    return hit
  }, String(needle), ms)
}

const input = (action: 'up' | 'down' | 'click' | 'double_click') =>
  fetch(`${automation}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })

/** The simulator returns lit pixels on a transparent background; kept as is, so the images sit on any color. */
async function shot(name: string): Promise<void> {
  await Bun.sleep(700) // let fades and the working dots settle
  const raw = PNG.sync.read(Buffer.from(await (await fetch(`${automation}/api/screenshot/glasses`)).arrayBuffer()))
  for (const scale of [1, 2]) {
    const out = new PNG({ width: raw.width * scale, height: raw.height * scale })
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const i = ((Math.floor(y / scale) * raw.width + Math.floor(x / scale)) * 4) as number
        const o = (y * out.width + x) * 4
        for (let c = 0; c < 4; c++) out.data[o + c] = raw.data[i + c]!
      }
    }
    await Bun.write(join(OUT, `${name}${scale === 2 ? '@2x' : ''}.png`), PNG.sync.write(out))
  }
  console.log(`saved ${name}`)
}

const tmp = mkdtempSync(join(tmpdir(), 'g2cc-shots-'))
try {
  mkdirSync(OUT, { recursive: true })
  const relayPort = freePort()
  procs.push(
    Bun.spawn(
      ['./node_modules/.bin/wrangler', 'dev', '--port', String(relayPort), '--ip', '127.0.0.1', '--persist-to', join(tmp, 'w'), '--show-interactive-dev-session=false', '--var', 'CONNECT_LIMIT_ENABLED:false'],
      { cwd: join(ROOT, 'relay'), stdout: 'ignore', stderr: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    ),
  )
  await waitFor(async () => (await fetch(`http://127.0.0.1:${relayPort}/`)).ok, 'relay')
  const vitePort = freePort()
  procs.push(
    Bun.spawn(['./node_modules/.bin/vite', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
      cwd: APP,
      stdout: 'ignore',
      stderr: 'ignore',
      env: { ...process.env, VITE_G2CC_FAKE_STT: TRANSCRIPT, VITE_STT_API_KEY: '' },
    }),
  )
  await waitFor(async () => (await fetch(`http://127.0.0.1:${vitePort}/`)).ok, 'vite')

  const relayUrl = `ws://127.0.0.1:${relayPort}`
  const key = generateKey()
  const computer = await SecureChannel.create(key, 'computer')
  const relay = new RelayClient({ url: relayRoomUrl(relayUrl, computer.roomId, 'computer', await relayAuthToken(key, computer.roomId)), onFrame: () => {} })
  relay.start()
  const send = async <K extends 'session' | 'event' | 'reply' | 'glance' | 'permission' | 'permission_resolved' | 'question'>(kind: K, body: Body<K>) =>
    relay.send(await computer.seal(kind, body, { sid: SID }))

  const autoPort = freePort()
  automation = `http://127.0.0.1:${autoPort}`
  const pairing = await encodePairing({ relayUrl, key })
  const url = `http://127.0.0.1:${vitePort}/#pair=${toBase64Url(new TextEncoder().encode(pairing))}`
  procs.push(Bun.spawn(['./node_modules/.bin/evenhub-simulator', '--no-glow', '--automation-port', String(autoPort), url], { cwd: APP, stdout: 'ignore', stderr: 'ignore' }))
  await waitFor(async () => (await (await fetch(`${automation}/api/ping`)).text()) === 'pong', 'simulator')
  await sawLog('[g2cc] ready', 30_000)

  // 1. The live feed.
  await send('session', { name: 'weather-app', cwd: '/x', state: 'working', mode: 'default' })
  await send('event', { type: 'prompt', summary: 'add a 5-day forecast to the home screen', origin: 'glasses' })
  await send('event', { type: 'tool_start', tool: 'Read', summary: 'src/api/forecast.ts' })
  await send('event', { type: 'tool_end', tool: 'Read', summary: 'read forecast.ts' })
  await send('event', { type: 'tool_start', tool: 'Edit', summary: 'src/screens/Home.tsx' })
  await send('event', { type: 'tool_end', tool: 'Edit', summary: 'edited Home.tsx' })
  await send('event', { type: 'tool_start', tool: 'Write', summary: 'src/components/ForecastCard.tsx' })
  await send('event', { type: 'tool_end', tool: 'Write', summary: 'wrote ForecastCard.tsx' })
  await send('event', { type: 'tool_start', tool: 'Bash', summary: 'bun test' })
  await send('event', { type: 'tool_end', tool: 'Bash', summary: 'ok' })
  await send('glance', { text: 'Forecast card added; tests pass' })
  await sawLog('Forecast card added')
  await shot('1-feed')

  // 2. A permission card.
  await send('session', { name: 'weather-app', cwd: '/x', state: 'waiting', mode: 'default' })
  await send('permission', {
    request_id: 'abcde',
    tool_name: 'Bash',
    description: 'Push the forecast branch to GitHub',
    input_preview: '{"command": "git push -u origin feature/forecast"}',
  })
  await sawLog(/frame .*"name":"card"/)
  await shot('2-approve')
  await send('permission_resolved', { request_id: 'abcde' })
  await sawLog(/frame (?!.*"name":"card")/)

  // 3. A question from Claude.
  await send('question', { question_id: 'q0000abcd', question: 'Tests pass. Open a pull request now?', options: ['Yes, open it', 'Run lint first', 'Not yet'] })
  await sawLog(/frame .*"name":"question"/)
  await shot('3-question')
  await input('click')
  await sawLog(/frame (?!.*"name":"question")/)

  // 4. Talking: the transcript waits for a confirm before anything is sent.
  await send('session', { name: 'weather-app', cwd: '/x', state: 'idle', mode: 'default' })
  await input('click')
  await sawLog(/frame .*"name":"menu"/)
  await input('click')
  await sawLog(/frame .*"name":"voice"/)
  await input('click') // done speaking
  await sawLog(TRANSCRIPT.slice(0, 30))
  await shot('4-talk')
  await input('double_click') // cancel

  // 5. The final reply.
  await send('session', { name: 'weather-app', cwd: '/x', state: 'working', mode: 'default' })
  await send('event', { type: 'prompt', summary: TRANSCRIPT, origin: 'glasses' })
  await send('event', { type: 'tool_start', tool: 'Bash', summary: 'gh pr create --fill' })
  await send('event', { type: 'tool_end', tool: 'Bash', summary: 'ok' })
  await send('session', { name: 'weather-app', cwd: '/x', state: 'idle', mode: 'default' })
  await send('reply', {
    text:
      'Opened PR #42, "Add a 5-day forecast to the home screen".\n\n' +
      'It adds a ForecastCard that shows the next five days with highs, lows, and an icon, and loads them from the existing forecast API. ' +
      'All 38 tests pass.',
  })
  await sawLog('Opened PR #42')
  await shot('5-reply')

  // 6. The menu.
  await input('double_click')
  await input('click')
  await sawLog(/frame .*"name":"menu"/)
  await shot('6-menu')

  relay.stop()
  console.log(`\n${OUT}`)
} finally {
  for (const p of procs.reverse()) p.kill()
  if (automation) Bun.spawnSync(['pkill', '-f', '--', `--automation-port ${new URL(automation).port}`])
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(0)
