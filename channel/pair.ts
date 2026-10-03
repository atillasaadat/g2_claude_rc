#!/usr/bin/env bun
// Pairs the glasses with this computer.
//
//   bun channel/pair.ts                                  show the current pairing
//   bun channel/pair.ts --relay wss://host/g2-claude     use a deployed relay (keeps the key)
//   bun channel/pair.ts --rotate                         new key: unpairs the glasses
//   bun channel/pair.ts --text                           also print the pairing text (installed app)
//
// The Groq key for voice prompts travels inside the pairing (never in the
// public app). It is read from GROQ_API_KEY, or on first use from the dev
// file apps/glasses/.env.local, and stored in ~/.g2cc/pairing.json (0600).
//
// For a deployed relay this prints one QR: the app URL with the pairing in
// the #fragment. Scan it in the Even app to load the app and pair in one step.
// The fragment never reaches the server. Treat the QR like a password.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import QRCode from 'qrcode'
import { toBase64Url } from '@g2cc/protocol'
import { DEFAULT_RELAY_URL, loadConfig } from './src/config'
import { appUrlFor, loadOrCreatePairing, pairingPath, pairingText } from './src/pairing-store'

const { values } = parseArgs({
  options: {
    relay: { type: 'string' },
    rotate: { type: 'boolean', default: false },
    'no-groq': { type: 'boolean', default: false },
    // Also print the pairing text, to paste into an installed app's phone view.
    text: { type: 'boolean', default: false },
  },
})

function groqKey(): string | undefined {
  if (values['no-groq']) return undefined
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY.trim()
  const devEnv = join(import.meta.dir, '..', 'apps', 'glasses', '.env.local')
  if (!existsSync(devEnv)) return undefined
  return /^VITE_STT_API_KEY=(.+)$/m.exec(readFileSync(devEnv, 'utf8'))?.[1]?.trim() || undefined
}

const cfg = loadConfig()
const relayUrl = values.relay ?? (existsSync(pairingPath(cfg.home)) ? undefined : DEFAULT_RELAY_URL)
const sttKey = groqKey()
const pairing = await loadOrCreatePairing(cfg.home, { relayUrl, rotate: values.rotate, ...(sttKey ? { sttKey } : {}) })
const text = await pairingText(pairing)
const appUrl = appUrlFor(pairing.relayUrl)

console.log(`relay:  ${pairing.relayUrl}`)
console.log(`file:   ${pairingPath(cfg.home)}`)
console.log(`voice:  ${pairing.sttKey ? 'Groq key included' : 'no Groq key (set GROQ_API_KEY and rerun to enable Talk)'}`)
if (appUrl) {
  const link = `${appUrl}#pair=${toBase64Url(new TextEncoder().encode(text))}`
  console.log('\nScan with the Even app (Even Hub > scan) to load the app and pair. Contains your secret key:\n')
  console.log(await QRCode.toString(link, { type: 'terminal', small: true }))
  if (values.text) console.log(`\nPairing text for an installed app (phone view > Pairing):\n\n${text}`)
} else {
  console.log('\nLocal relay: open the app from your dev server, then paste this pairing text (contains your secret key):\n')
  console.log(await QRCode.toString(text, { type: 'terminal', small: true }))
  console.log(text)
}
