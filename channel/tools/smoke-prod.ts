#!/usr/bin/env bun
// Checks the live deployment end to end, as the nightly workflow does:
//   bun channel/tools/smoke-prod.ts [https://atillasaadat.com/g2-claude]
// Uses throwaway keys and rooms; nothing it creates is ever paired to anyone.

import { generateKey, GlassesPairing, relayAuthToken, relayPairUrl, relayRoomUrl, RelayClient, SecureChannel } from '@g2cc/protocol'
import { openCodePairing } from '../src/code-pairing'

const SITE = (process.argv[2] ?? 'https://atillasaadat.com/g2-claude').replace(/\/+$/, '')
const RELAY = SITE.replace(/^http/, 'ws')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
  if (!ok) failures++
}
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>(r => setTimeout(() => r(fallback), ms))])

// 1. Pages and their headers.
for (const [path, wantCsp] of [['/', true], ['/app/', true], ['/qr/', true], ['/qr/qr.js', false]] as const) {
  const res = await fetch(`${SITE}${path}`)
  const h = res.headers
  check(`page ${path}`, res.status === 200, `HTTP ${res.status}`)
  check(`page ${path} headers`, h.get('x-content-type-options') === 'nosniff' && h.get('referrer-policy') === 'no-referrer' && (!wantCsp || Boolean(h.get('content-security-policy'))))
}

// 2. Key rooms: refused without the token or with a wrong one, round trip with it.
const key = generateKey()
const computer = await SecureChannel.create(key, 'computer')
const glasses = await SecureChannel.create(key, 'glasses')
const token = await relayAuthToken(key, computer.roomId)
const opens = (url: string): Promise<boolean> =>
  withTimeout(
    new Promise<boolean>(res => {
      const ws = new WebSocket(url)
      ws.onopen = () => (ws.close(), res(true))
      ws.onerror = () => res(false)
    }),
    10_000,
    false,
  )
check('room refuses a socket without a token', !(await opens(`${RELAY}/v1/room/${computer.roomId}?role=glasses`)))
const started = Date.now()
const got = new Promise<string>(resolve => {
  const g: RelayClient = new RelayClient({
    url: relayRoomUrl(RELAY, glasses.roomId, 'glasses', token),
    onFrame: async f => {
      const env = await glasses.open(f)
      if (env?.kind === 'glance') (resolve(env.body.text), g.stop())
    },
  })
  g.start()
})
const c = new RelayClient({ url: relayRoomUrl(RELAY, computer.roomId, 'computer', token), onFrame: () => {} })
c.start()
c.send(await computer.seal('glance', { text: 'nightly smoke' }))
const text = await withTimeout(got, 15_000, '')
check('encrypted round trip with the token', text === 'nightly smoke', `${Date.now() - started} ms`)
check('room refuses a forged token', !(await opens(relayRoomUrl(RELAY, computer.roomId, 'glasses', await relayAuthToken(generateKey(), computer.roomId)))))
c.stop()

// 3. Pairing by code through a pairing room.
const open = await openCodePairing({ relayUrl: RELAY, key: generateKey() }, { ttlMs: 30_000 })
const phone = await GlassesPairing.create(open.code)
const paired = new Promise<boolean>(resolve => {
  const r: RelayClient = new RelayClient({
    url: relayPairUrl(RELAY, phone.roomId, 'glasses'),
    onFrame: async f => {
      const x = await phone.onFrame(f)
      if (x.send) r.send(x.send)
      if (x.pairingText) (resolve(JSON.parse(x.pairingText).relayUrl === RELAY), setTimeout(() => r.stop(), 500))
    },
  })
  r.start()
})
check('code pairing: the phone gets the pairing', await withTimeout(paired, 20_000, false))
check('code pairing: the computer sees it done', await withTimeout(open.done, 10_000, false))

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
