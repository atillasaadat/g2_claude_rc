// End-to-end: two clients exchange encrypted envelopes through `wrangler dev`.
// This is the Phase 1 "done" check.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKey, relayAuthToken, SecureChannel } from '@g2cc/protocol'
import { BURST, HISTORY_MAX, HISTORY_MAX_BYTES, MAX_FRAME_BYTES, MAX_SOCKETS_PER_ROLE, PAIR_HISTORY_MAX } from '../src/limits'
import { ipKey } from '../src/ip'

const RELAY_DIR = join(import.meta.dir, '..')
let base = ''
let proc: ReturnType<typeof Bun.spawn> | null = null
let stateDir = ''

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = s.port as number
  s.stop(true)
  return port
}

beforeAll(async () => {
  const port = freePort()
  stateDir = mkdtempSync(join(tmpdir(), 'g2cc-relay-'))
  proc = Bun.spawn(
    ['./node_modules/.bin/wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', stateDir, '--show-interactive-dev-session=false', '--var', 'CONNECT_LIMIT_ENABLED:false'],
    { cwd: RELAY_DIR, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  )
  base = `127.0.0.1:${port}`
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://${base}/`)).ok) return
    } catch {}
    await Bun.sleep(500)
  }
  throw new Error('wrangler dev did not start')
}, 90_000)

afterAll(() => {
  proc?.kill()
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

/** Auth token per key room, filled by room(). */
const AUTH = new Map<string, string>()
const roomUrl = (roomId: string, role: string, auth = AUTH.get(roomId) ?? '') =>
  `ws://${base}/v1/room/${roomId}?role=${role}&auth=${auth}`

type Presence = { t: 'presence'; computer: number; glasses: number }

class Client {
  readonly frames: Uint8Array[] = []
  readonly presence: Presence[] = []
  readonly texts: string[] = []
  closed: { code: number } | null = null
  private waiters: Array<() => void> = []

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = 'arraybuffer'
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') {
        this.texts.push(ev.data)
        try {
          const msg = JSON.parse(ev.data)
          if (msg.t === 'presence') this.presence.push(msg)
        } catch {}
      } else {
        this.frames.push(new Uint8Array(ev.data as ArrayBuffer))
      }
      this.wake()
    }
    ws.onclose = ev => {
      this.closed = { code: ev.code }
      this.wake()
    }
  }

  static async connect(roomId: string, role: 'computer' | 'glasses', path?: string): Promise<Client> {
    const ws = new WebSocket(path ?? roomUrl(roomId, role))
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('connect failed'))
    })
    return new Client(ws)
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w()
  }

  async until(pred: () => boolean, ms = 5_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!pred()) {
      const left = deadline - Date.now()
      if (left <= 0) throw new Error('timed out waiting')
      await new Promise<void>(r => {
        this.waiters.push(r)
        setTimeout(r, left)
      })
    }
  }

  close(): void {
    this.ws.close(1000)
  }
}

async function room() {
  const key = generateKey()
  const computer = await SecureChannel.create(key, 'computer')
  const glasses = await SecureChannel.create(key, 'glasses')
  AUTH.set(computer.roomId, await relayAuthToken(key, computer.roomId))
  return { roomId: computer.roomId, computer, glasses, key }
}

describe('relay over wrangler dev', () => {
  test('serves the setup guide and app under /g2-claude, and redirects the bare paths', async () => {
    expect((await fetch(`http://${base}/g2-claude/`)).status).toBe(200)
    const root = await fetch(`http://${base}/`, { redirect: 'manual' })
    expect([root.status, root.headers.get('location')]).toEqual([302, `http://${base}/g2-claude/`])
  })

  test('the relay also answers under the /g2-claude prefix', async () => {
    const { roomId, computer, glasses } = await room()
    const ws = new WebSocket(`ws://${base}/g2-claude/v1/room/${roomId}?role=glasses&auth=${AUTH.get(roomId)}`)
    ws.binaryType = 'arraybuffer'
    const got = new Promise<Uint8Array>(resolve => {
      ws.onmessage = ev => typeof ev.data !== 'string' && resolve(new Uint8Array(ev.data as ArrayBuffer))
    })
    await new Promise(r => (ws.onopen = r))
    const c = await Client.connect(roomId, 'computer')
    c.ws.send(await computer.seal('glance', { text: 'via prefix' }))
    expect((await glasses.open(await got))?.body).toEqual({ text: 'via prefix' })
    ws.close()
    c.close()
  })

  test('rejects bad room ids, roles, and non-upgrade requests', async () => {
    const { roomId } = await room()
    expect((await fetch(`http://${base}/v1/room/not-hex?role=computer`)).status).toBe(404) // not a room: falls through to assets
    expect((await fetch(`http://${base}/v1/room/${roomId}?role=admin`, { headers: { Upgrade: 'websocket' } })).status).toBe(400)
    expect((await fetch(`http://${base}/v1/room/${roomId}?role=computer`)).status).toBe(426)
  })

  test('a key room turns away sockets without the pinned auth token', async () => {
    const { roomId } = await room()
    const up = { headers: { Upgrade: 'websocket' } }
    expect((await fetch(`http://${base}/v1/room/${roomId}?role=computer`, up)).status).toBe(401)
    const c = await Client.connect(roomId, 'computer') // pins the token
    const forged = await relayAuthToken(generateKey(), roomId)
    expect((await fetch(`http://${base}/v1/room/${roomId}?role=glasses&auth=${forged}`, up)).status).toBe(403)
    const g = await Client.connect(roomId, 'glasses')
    await g.until(() => g.presence.some(p => p.computer === 1))
    c.close()
    g.close()
  })

  test('pairing rooms need no token, keep a short history, and refuse newcomers when full', async () => {
    const id = crypto.randomUUID().replace(/-/g, '')
    const pairUrl = (role: string) => `ws://${base}/v1/pair/${id}?role=${role}`
    const c = await Client.connect(id, 'computer', pairUrl('computer'))
    for (let i = 0; i < PAIR_HISTORY_MAX + 5; i++) c.ws.send(new Uint8Array([i]))
    await Bun.sleep(300)
    const g = await Client.connect(id, 'glasses', pairUrl('glasses'))
    await g.until(() => g.frames.length >= PAIR_HISTORY_MAX)
    await Bun.sleep(200)
    expect(g.frames.length).toBe(PAIR_HISTORY_MAX)
    const rest: Client[] = []
    for (let i = 1; i < MAX_SOCKETS_PER_ROLE; i++) rest.push(await Client.connect(id, 'computer', pairUrl('computer')))
    expect((await fetch(`http://${base}/v1/pair/${id}?role=computer`, { headers: { Upgrade: 'websocket' } })).status).toBe(409)
    expect(c.closed).toBeNull()
    for (const x of [c, g, ...rest]) x.close()
  })

  test('IPv6 clients are rate limited per /64', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7')
    expect(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64')
    expect(ipKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64')
    expect(ipKey('2001:0db8:0001:0002:ffff::')).toBe('2001:db8:1:2::/64')
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
  })

  test('exchanges encrypted envelopes both ways', async () => {
    const { roomId, computer, glasses } = await room()
    const c = await Client.connect(roomId, 'computer')
    const g = await Client.connect(roomId, 'glasses')

    c.ws.send(await computer.seal('reply', { text: 'Tests pass.' }))
    await g.until(() => g.frames.length >= 1)
    expect((await glasses.open(g.frames[0]!))?.body).toEqual({ text: 'Tests pass.' })

    g.ws.send(await glasses.seal('verdict', { request_id: 'abcde', behavior: 'allow' }))
    await c.until(() => c.frames.length >= 1)
    expect((await computer.open(c.frames[0]!))?.body).toEqual({ request_id: 'abcde', behavior: 'allow' })

    // The relay forwards ciphertext only: the plaintext never appears on the wire.
    expect(new TextDecoder().decode(g.frames[0]!)).not.toContain('Tests pass.')
    c.close()
    g.close()
  })

  test('reports presence to both sides', async () => {
    const { roomId } = await room()
    const g = await Client.connect(roomId, 'glasses')
    await g.until(() => g.presence.some(p => p.glasses === 1 && p.computer === 0))
    const c = await Client.connect(roomId, 'computer')
    await g.until(() => g.presence.some(p => p.computer === 1))
    c.close()
    await g.until(() => g.presence.at(-1)?.computer === 0)
    g.close()
  })

  test('replays recent history to glasses that join late', async () => {
    const { roomId, computer, glasses } = await room()
    const c = await Client.connect(roomId, 'computer')
    for (let i = 0; i < 3; i++) c.ws.send(await computer.seal('glance', { text: `step ${i}` }))
    await Bun.sleep(300)

    const g = await Client.connect(roomId, 'glasses')
    await g.until(() => g.frames.length >= 3)
    const texts = await Promise.all(g.frames.map(async f => (await glasses.open(f))?.body))
    expect(texts).toEqual([{ text: 'step 0' }, { text: 'step 1' }, { text: 'step 2' }])
    c.close()
    g.close()
  })

  test('caps history at HISTORY_MAX frames', async () => {
    const { roomId, computer } = await room()
    const c = await Client.connect(roomId, 'computer')
    const total = HISTORY_MAX + 10
    // Stay under the rate limit by pacing the sends.
    for (let i = 0; i < total; i++) {
      c.ws.send(await computer.seal('glance', { text: `${i}` }))
      if (i % 15 === 14) await Bun.sleep(800)
    }
    await Bun.sleep(500)
    const g = await Client.connect(roomId, 'glasses')
    await g.until(() => g.frames.length >= HISTORY_MAX)
    await Bun.sleep(300)
    expect(g.frames.length).toBe(HISTORY_MAX)
    c.close()
    g.close()
  }, 30_000)

  test('queues commands while the computer is offline; redelivery is deduped by the channel', async () => {
    const { roomId, computer, glasses } = await room()
    const g = await Client.connect(roomId, 'glasses')
    g.ws.send(await glasses.seal('prompt', { text: 'run the tests' }))
    await Bun.sleep(300)

    const c1 = await Client.connect(roomId, 'computer')
    await c1.until(() => c1.frames.length >= 1)
    expect((await computer.open(c1.frames[0]!))?.body).toEqual({ text: 'run the tests' })
    c1.close()
    await Bun.sleep(300)

    // The relay delivers again on reconnect, but the same channel drops the duplicate.
    const c2 = await Client.connect(roomId, 'computer')
    await c2.until(() => c2.frames.length >= 1)
    expect(await computer.open(c2.frames[0]!)).toBeNull()
    c2.close()
    g.close()
  })

  test('an impostor computer cannot swallow queued commands', async () => {
    const { roomId, computer, glasses } = await room()
    const g = await Client.connect(roomId, 'glasses')
    g.ws.send(await glasses.seal('stop', {}))
    await Bun.sleep(300)

    const impostor = await Client.connect(roomId, 'computer')
    await impostor.until(() => impostor.frames.length >= 1)
    impostor.close()
    await Bun.sleep(300)

    const real = await Client.connect(roomId, 'computer')
    await real.until(() => real.frames.length >= 1)
    expect((await computer.open(real.frames[0]!))?.kind).toBe('stop')
    real.close()
    g.close()
  })

  test('a full role evicts its oldest socket instead of refusing the newcomer', async () => {
    const { roomId } = await room()
    const first = await Client.connect(roomId, 'computer')
    const rest: Client[] = []
    for (let i = 0; i < MAX_SOCKETS_PER_ROLE; i++) rest.push(await Client.connect(roomId, 'computer'))
    await first.until(() => first.closed !== null)
    expect(first.closed?.code).toBe(4000)
    for (const c of rest) expect(c.closed).toBeNull()
    for (const c of rest) c.close()
  })

  test('caps replayed history by bytes', async () => {
    const { roomId } = await room()
    const c = await Client.connect(roomId, 'computer')
    const big = new Uint8Array(60 * 1024).fill(7)
    for (let i = 0; i < 25; i++) c.ws.send(big)
    await Bun.sleep(500)
    const g = await Client.connect(roomId, 'glasses')
    await g.until(() => g.frames.length >= 1)
    await Bun.sleep(500)
    const total = g.frames.reduce((n, f) => n + f.length, 0)
    expect(total).toBeLessThanOrEqual(HISTORY_MAX_BYTES)
    expect(g.frames.length).toBeGreaterThan(10)
    c.close()
    g.close()
  })

  test('isolates rooms', async () => {
    const a = await room()
    const b = await room()
    const ca = await Client.connect(a.roomId, 'computer')
    const gb = await Client.connect(b.roomId, 'glasses')
    ca.ws.send(await a.computer.seal('reply', { text: 'for room a' }))
    await Bun.sleep(500)
    expect(gb.frames.length).toBe(0)
    ca.close()
    gb.close()
  })

  test('answers ping with pong', async () => {
    const { roomId } = await room()
    const c = await Client.connect(roomId, 'computer')
    c.ws.send('ping')
    await c.until(() => c.texts.includes('pong'))
    c.close()
  })

  test('closes on text frames and oversized frames', async () => {
    const { roomId } = await room()
    const c1 = await Client.connect(roomId, 'computer')
    c1.ws.send('hello')
    await c1.until(() => c1.closed !== null)
    expect(c1.closed?.code).toBe(1003)

    const c2 = await Client.connect(roomId, 'computer')
    c2.ws.send(new Uint8Array(MAX_FRAME_BYTES + 1))
    await c2.until(() => c2.closed !== null)
    expect(c2.closed?.code).toBe(1009)
  })

  test('drops frames over the rate limit', async () => {
    const { roomId, computer } = await room()
    const c = await Client.connect(roomId, 'computer')
    const g = await Client.connect(roomId, 'glasses')
    const frame = await computer.seal('glance', { text: 'flood' })
    for (let i = 0; i < BURST * 3; i++) c.ws.send(frame)
    await Bun.sleep(1_000)
    expect(g.frames.length).toBeGreaterThan(0)
    expect(g.frames.length).toBeLessThan(BURST * 2)
    await c.until(() => c.texts.some(t => t.includes('rate_limited')))
    c.close()
    g.close()
  })
})
