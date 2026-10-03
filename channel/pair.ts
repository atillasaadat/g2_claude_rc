#!/usr/bin/env bun
// Prints the pairing payload for the glasses app, as a QR code and as text.
//
//   bun channel/pair.ts                       show the current pairing
//   bun channel/pair.ts --relay wss://...     set the relay URL (keeps the key)
//   bun channel/pair.ts --rotate              new key: unpairs the glasses

import { parseArgs } from 'node:util'
import QRCode from 'qrcode'
import { existsSync } from 'node:fs'
import { DEFAULT_RELAY_URL, loadConfig } from './src/config'
import { loadOrCreatePairing, pairingPath, pairingText } from './src/pairing-store'

const { values } = parseArgs({
  options: { relay: { type: 'string' }, rotate: { type: 'boolean', default: false } },
})

const cfg = loadConfig()
const relayUrl = values.relay ?? (existsSync(pairingPath(cfg.home)) ? undefined : DEFAULT_RELAY_URL)
const pairing = await loadOrCreatePairing(cfg.home, { relayUrl, rotate: values.rotate })
const text = await pairingText(pairing)

console.log(await QRCode.toString(text, { type: 'terminal', small: true }))
console.log(`relay: ${pairing.relayUrl}`)
console.log(`file:  ${pairingPath(cfg.home)}`)
console.log('\nPairing text (contains the secret key, treat it like a password):\n')
console.log(text)
