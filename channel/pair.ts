#!/usr/bin/env bun
// Pairs the phone app with this computer from a terminal. Inside Claude Code,
// /g2:pair does the same through the channel's `pair` tool.
//
//   bun channel/pair.ts                      show a one-time code, wait for the phone
//   bun channel/pair.ts --text               print the pairing text instead (paste it in the app)
//   bun channel/pair.ts --relay <wss-url>    use another relay (self-hosting, or ws://127.0.0.1:8789)
//   bun channel/pair.ts --rotate             new key: unpairs every phone first
//
// The pairing lives in ~/.g2cc/pairing.json (0600). The Groq key for voice is
// entered in the phone app. For self-hosting, GROQ_API_KEY here puts it in the
// pairing instead.

import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { DEFAULT_RELAY_URL, loadConfig } from './src/config'
import { openCodePairing } from './src/code-pairing'
import { loadOrCreatePairing, pairingPath, pairingText } from './src/pairing-store'

const { values } = parseArgs({
  options: {
    relay: { type: 'string' },
    rotate: { type: 'boolean', default: false },
    text: { type: 'boolean', default: false },
  },
})

const cfg = loadConfig()
const relayUrl = values.relay ?? cfg.relayUrlOverride ?? (existsSync(pairingPath(cfg.home)) ? undefined : DEFAULT_RELAY_URL)
const sttKey = process.env.GROQ_API_KEY?.trim()
const pairing = await loadOrCreatePairing(cfg.home, { relayUrl, rotate: values.rotate, ...(sttKey ? { sttKey } : {}) })

console.log(`relay:  ${pairing.relayUrl}`)
console.log(`file:   ${pairingPath(cfg.home)}`)

if (values.text) {
  console.log(`\nPairing text (contains your secret key). In the phone app: Pairing > Paste text.\n\n${await pairingText(pairing)}`)
  process.exit(0)
}

const open = await openCodePairing(pairing)
const minutes = Math.round((open.expiresAt - Date.now()) / 60_000)
console.log(`\n  Pairing code:  ${open.code}\n`)
console.log(`In the G2 Claude Code app on your phone, open Pairing and enter the code.`)
console.log(`It works once and expires in ${minutes} minutes. Waiting...`)
process.on('SIGINT', () => open.cancel())
const ok = await open.done
console.log(ok ? 'Paired.' : 'The code expired or was cancelled. Run this again for a new one.')
process.exit(ok ? 0 : 1)
