#!/usr/bin/env bun
// CLI stand-in for the glasses: joins the room as `glasses` and prints the
// decrypted feed. Phase 2 test client.
//
//   bun channel/tools/feed.ts

import { SecureChannel, type AnyEnvelope } from '@g2cc/protocol'
import { loadConfig, relaySocketUrl } from '../src/config'
import { loadOrCreatePairing } from '../src/pairing-store'
import { RelayClient } from '@g2cc/protocol'

const pairing = await loadOrCreatePairing(loadConfig().home)
const glasses = await SecureChannel.create(pairing.key, 'glasses')

const time = (ts: number): string => new Date(ts).toLocaleTimeString()

function line(env: AnyEnvelope): string {
  switch (env.kind) {
    case 'session':
      return `== ${env.body.name} · ${env.body.state}${env.body.mode ? ` · ${env.body.mode}` : ''}`
    case 'event': {
      const who = env.body.origin === 'glasses' ? ' (glasses)' : ''
      return `${env.body.type.padEnd(10)} ${env.body.tool ? `${env.body.tool}: ` : ''}${env.body.summary}${who}`
    }
    case 'reply':
      return `reply      ${env.body.text.replace(/\n/g, '\n           ')}`
    case 'glance':
      return `glance     ${env.body.text}`
    default:
      return `${env.kind.padEnd(10)} ${JSON.stringify(env.body)}`
  }
}

const relay = new RelayClient({
  url: relaySocketUrl(pairing.relayUrl, glasses.roomId, 'glasses'),
  onStatus: s => console.error(`[relay ${s}]`),
  onPresence: p => console.error(`[presence computer=${p.computer} glasses=${p.glasses}]`),
  onFrame: async frame => {
    const env = await glasses.open(frame)
    if (env) console.log(`${time(env.ts)}${env.sid ? ` [${env.sid.slice(0, 8)}]` : ''} ${line(env)}`)
  },
})
relay.start()
console.error(`room ${glasses.roomId} via ${pairing.relayUrl}`)
