import { afterEach, describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { RelayClient, type RelayStatus } from '../src/relay-client'

// A tiny stand-in for the relay: records binary frames, can drop connections.
function fakeRelay() {
  const received: Uint8Array[] = []
  const texts: string[] = []
  const sockets = new Set<ServerWebSocket<unknown>>()
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
        ws.send(JSON.stringify({ t: 'presence', computer: 1, glasses: 0 }))
      },
      message(ws, msg) {
        if (typeof msg === 'string') {
          texts.push(msg)
          if (msg === 'ping') ws.send('pong')
        } else {
          received.push(new Uint8Array(msg))
        }
      },
      close(ws) {
        sockets.delete(ws)
      },
    },
  })
  return {
    url: `ws://127.0.0.1:${server.port}`,
    received,
    texts,
    sockets,
    send: (data: Uint8Array) => sockets.forEach(s => s.send(data)),
    dropAll: () => sockets.forEach(s => s.close(1012, 'restart')),
    stop: () => server.stop(true),
  }
}

async function until(pred: () => boolean, ms = 3_000) {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(10)
  }
}

let cleanup: Array<() => void> = []
afterEach(() => {
  cleanup.forEach(f => f())
  cleanup = []
})

function client(url: string, extra: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) {
  const statuses: RelayStatus[] = []
  const frames: Uint8Array[] = []
  const c = new RelayClient({
    url,
    onFrame: f => frames.push(f),
    onStatus: s => statuses.push(s),
    minBackoffMs: 20,
    maxBackoffMs: 100,
    ...extra,
  })
  cleanup.push(() => c.stop())
  return { c, statuses, frames }
}

describe('RelayClient', () => {
  test('connects, sends frames, receives frames and presence', async () => {
    const relay = fakeRelay()
    cleanup.push(relay.stop)
    const presence: unknown[] = []
    const { c, frames, statuses } = client(relay.url, { onPresence: p => presence.push(p) })
    c.start()
    await until(() => statuses.includes('open'))
    c.send(Uint8Array.of(1, 2, 3))
    await until(() => relay.received.length === 1)
    expect(relay.received[0]).toEqual(Uint8Array.of(1, 2, 3))
    relay.send(Uint8Array.of(9))
    await until(() => frames.length === 1)
    expect(frames[0]).toEqual(Uint8Array.of(9))
    expect(presence).toEqual([{ t: 'presence', computer: 1, glasses: 0 }])
  })

  test('buffers frames while disconnected and flushes them in order', async () => {
    const relay = fakeRelay()
    cleanup.push(relay.stop)
    const { c } = client(relay.url)
    c.send(Uint8Array.of(1))
    c.send(Uint8Array.of(2))
    c.start()
    await until(() => relay.received.length === 2)
    expect(relay.received.map(f => f[0])).toEqual([1, 2])
  })

  test('keeps only the newest bufferMax frames', async () => {
    const relay = fakeRelay()
    cleanup.push(relay.stop)
    const { c } = client(relay.url, { bufferMax: 3 })
    for (let i = 0; i < 10; i++) c.send(Uint8Array.of(i))
    c.start()
    await until(() => relay.received.length === 3)
    await Bun.sleep(50)
    expect(relay.received.map(f => f[0])).toEqual([7, 8, 9])
  })

  test('reconnects after the relay drops the connection', async () => {
    const relay = fakeRelay()
    cleanup.push(relay.stop)
    const { c, statuses } = client(relay.url)
    c.start()
    await until(() => statuses.filter(s => s === 'open').length === 1)
    relay.dropAll()
    await until(() => statuses.filter(s => s === 'open').length === 2)
    c.send(Uint8Array.of(5))
    await until(() => relay.received.length === 1)
  })

  test('keeps retrying while the relay is down', async () => {
    const relay = fakeRelay()
    const url = relay.url
    relay.stop()
    const { c, statuses } = client(url)
    c.start()
    await until(() => statuses.filter(s => s === 'closed').length >= 2)
    expect(statuses).not.toContain('open')
  })

  test('sends keepalive pings', async () => {
    const relay = fakeRelay()
    cleanup.push(relay.stop)
    const { c } = client(relay.url, { pingIntervalMs: 30 })
    c.start()
    await until(() => relay.texts.includes('ping'))
  })

  test('stop closes the socket and stops reconnecting', async () => {
    const relay = fakeRelay()
    cleanup.push(relay.stop)
    const { c, statuses } = client(relay.url)
    c.start()
    await until(() => statuses.includes('open'))
    c.stop()
    await until(() => relay.sockets.size === 0)
    await Bun.sleep(200)
    expect(statuses.filter(s => s === 'open').length).toBe(1)
  })
})
