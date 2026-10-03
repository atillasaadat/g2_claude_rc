import { describe, expect, test } from 'bun:test'
import { GlassesPairing } from '@g2cc/protocol'
import { openCodePairing } from '../src/code-pairing'

// A fake relay room: frames from one role reach the other, with history for
// late joiners, like the real Durable Object.
class FakeRelay {
  static rooms = new Map<string, FakeRelay>()
  history: Uint8Array[] = []
  glasses: ((f: Uint8Array) => void) | null = null
  computer: ((f: Uint8Array) => void) | null = null
}

describe('openCodePairing over a relay', () => {
  test('a phone that types the code receives the pairing', async () => {
    type Data = { room: string; role: string | null }
    const server = Bun.serve<Data, never>({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url)
        const room = /\/v1\/room\/([0-9a-f]{32})/.exec(url.pathname)![1]!
        srv.upgrade(req, { data: { room, role: url.searchParams.get('role') } })
        return undefined
      },
      websocket: {
        open(ws) {
          const { room, role } = ws.data
          const r = FakeRelay.rooms.get(room) ?? new FakeRelay()
          FakeRelay.rooms.set(room, r)
          const deliver = (f: Uint8Array) => ws.send(f)
          if (role === 'glasses') {
            r.glasses = deliver
            for (const f of r.history) deliver(f)
          } else r.computer = deliver
        },
        message(ws, msg) {
          const { room, role } = ws.data
          const r = FakeRelay.rooms.get(room)!
          if (typeof msg === 'string') return
          const f = new Uint8Array(msg)
          if (role === 'computer') {
            r.history.push(f)
            r.glasses?.(f)
          } else r.computer?.(f)
        },
      },
    })
    try {
      const relayUrl = `ws://127.0.0.1:${server.port}`
      const pairing = { relayUrl, key: new Uint8Array(32).fill(7) }
      const open = await openCodePairing(pairing, { ttlMs: 10_000 })
      expect(open.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)

      // The phone joins after the code is shown.
      await Bun.sleep(100)
      const phone = await GlassesPairing.create(open.code)
      const got = new Promise<string>(resolve => {
        const ws = new WebSocket(`${relayUrl}/v1/room/${phone.roomId}?role=glasses`)
        ws.binaryType = 'arraybuffer'
        ws.onmessage = async ev => {
          if (typeof ev.data === 'string') return
          const r = await phone.onFrame(new Uint8Array(ev.data as ArrayBuffer))
          if (r.send) ws.send(r.send)
          if (r.pairingText) resolve(r.pairingText)
        }
      })
      const text = await got
      expect(JSON.parse(text)).toMatchObject({ v: 1, relayUrl })
      expect(await open.done).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test('an unused code expires', async () => {
    const open = await openCodePairing({ relayUrl: 'ws://127.0.0.1:9', key: new Uint8Array(32) }, { ttlMs: 50 })
    expect(await open.done).toBe(false)
  })
})
