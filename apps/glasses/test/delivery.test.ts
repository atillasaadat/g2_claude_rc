// Voice prompts are acked by the computer and resent until they are.
import { afterEach, describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { encodePairing, decodePairing, generateKey, RelayClient, relayAuthToken, relayRoomUrl, SecureChannel, type Pairing } from '@g2cc/protocol'
import { Links } from '../src/link'
import { reduce, type AppState, type Msg } from '../src/state'
import { env, g, NOW, paired, perm, recv } from './helpers'

describe('delivery in the reducer', () => {
  const sent = (s: AppState, ok: boolean): AppState => reduce(s, { type: 'delivery', sid: '', ok, text: 'run the tests', now: NOW }).state

  test('an acked prompt shows a brief Sent in the header', () => {
    const s = sent(paired(), true)
    expect(s.toast?.text).toBe('→ Sent to g2cc-sandbox')
    expect(s.screen).toBe('timeline')
  })

  test('a prompt that could not be delivered comes back for review, and a tap sends it again', () => {
    const s = sent(paired(), false)
    expect(s.screen).toBe('voice')
    expect(s.voice).toMatchObject({ phase: 'review', text: 'run the tests', failed: true })
    const again = g(s, 'tap')
    expect(again.effects).toEqual([{ type: 'send', kind: 'prompt', body: { text: 'run the tests' }, sid: '', room: '' }])
    expect(again.state.voice.failed).toBeUndefined()
  })

  test('a permission card on screen stays: a toast says the prompt was not delivered', () => {
    let s = recv(paired(), env('permission', perm()))
    expect(s.screen).toBe('card')
    s = sent(s, false)
    expect(s.screen).toBe('card')
    expect(s.toast?.text).toMatch(/^× Not delivered to g2cc-sandbox/)
  })
})

// A stand-in relay: forwards binary frames between roles and answers pings.
// `dropToComputer` loses that many frames on the way to the computer, like a dying phone link.
function fakeRelay() {
  const sockets = new Set<ServerWebSocket<{ role: string }>>()
  const state = { dropToComputer: 0 }
  const server = Bun.serve<{ role: string }>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      const role = new URL(req.url).searchParams.get('role') ?? ''
      return srv.upgrade(req, { data: { role } }) ? undefined : new Response('no', { status: 400 })
    },
    websocket: {
      open: ws => void sockets.add(ws),
      close: ws => void sockets.delete(ws),
      message(ws, msg) {
        if (msg === 'ping') return void ws.send('pong')
        if (typeof msg === 'string') return
        if (ws.data.role === 'glasses' && state.dropToComputer > 0) {
          state.dropToComputer -= 1
          return
        }
        for (const peer of sockets) if (peer.data.role !== ws.data.role) peer.send(msg)
      },
    },
  })
  return { url: `ws://127.0.0.1:${server.port}`, state, stop: () => server.stop(true) }
}

async function until(pred: () => boolean, ms = 3_000): Promise<void> {
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

/**
 * The phone's Links and a computer that acks like the channel does (or, with
 * `acks: false`, like an older plugin that never acks).
 */
async function setup(opts: { acks: boolean }) {
  const relay = fakeRelay()
  const key = generateKey()
  const pairing: Pairing = await decodePairing(await encodePairing({ relayUrl: relay.url, key }))
  const computer = await SecureChannel.create(key, 'computer')
  const prompts: string[] = []
  const computerRelay: RelayClient = new RelayClient({
    url: relayRoomUrl(relay.url, computer.roomId, 'computer', await relayAuthToken(key, computer.roomId)),
    onFrame: async f => {
      const r = await computer.openTracked(f)
      if (!r) return
      if (opts.acks) computerRelay.send(await computer.seal('ack', { ids: [r.env.id] }, { sid: 's1' }))
      if (!r.duplicate && r.env.kind === 'prompt') prompts.push(r.env.body.text)
    },
  })
  computerRelay.start()
  const msgs: Msg[] = []
  const links = new Links(m => msgs.push(m), { resendAfterMs: [150, 300], giveUpAfterMs: 600 })
  await links.connect(pairing)
  await until(() => msgs.some(m => m.type === 'relay' && m.status === 'open'))
  // A current channel says it acks when the glasses join.
  if (opts.acks) computerRelay.send(await computer.seal('ack', { ids: [] }, { sid: 's1' }))
  cleanup.push(() => {
    links.closeAll()
    computerRelay.stop()
    relay.stop()
  })
  return { relay, links, msgs, prompts, room: pairing.roomId }
}

const deliveries = (msgs: Msg[]) => msgs.filter((m): m is Extract<Msg, { type: 'delivery' }> => m.type === 'delivery')

describe('Links.sendPrompt', () => {
  test('the computer acks the prompt: delivered once', async () => {
    const { links, msgs, prompts, room } = await setup({ acks: true })
    await Bun.sleep(50)
    await links.sendPrompt('run the tests', 's1', room)
    await until(() => deliveries(msgs).length === 1)
    expect(deliveries(msgs)[0]).toMatchObject({ sid: 's1', ok: true, text: 'run the tests' })
    await Bun.sleep(400) // past the resends: none go out after the ack
    expect(prompts).toEqual(['run the tests'])
  })

  test('a lost prompt is resent until it arrives, and acted on once', async () => {
    const { relay, links, msgs, prompts, room } = await setup({ acks: true })
    await Bun.sleep(50)
    relay.state.dropToComputer = 1
    await links.sendPrompt('check the build', 's1', room)
    await until(() => deliveries(msgs).length === 1)
    expect(deliveries(msgs)[0]!.ok).toBe(true)
    expect(prompts).toEqual(['check the build'])
  })

  test('never acked by a channel that acks: reported as not delivered', async () => {
    const { relay, links, msgs, room } = await setup({ acks: true })
    await Bun.sleep(50)
    relay.state.dropToComputer = 99
    await links.sendPrompt('deploy', 's1', room)
    await until(() => deliveries(msgs).length === 1)
    expect(deliveries(msgs)[0]).toMatchObject({ ok: false, text: 'deploy' })
  })

  test('an older plugin that never acks gets no report either way', async () => {
    const { links, msgs, prompts, room } = await setup({ acks: false })
    await links.sendPrompt('hello', 's1', room)
    await until(() => prompts.length === 1)
    await Bun.sleep(800)
    expect(deliveries(msgs)).toEqual([])
    expect(prompts).toEqual(['hello'])
  })
})
