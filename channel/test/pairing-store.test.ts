import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodePairing } from '@g2cc/protocol'
import { appUrlFor, loadOrCreatePairing, pairingText } from '../src/pairing-store'

let dirs: string[] = []
afterEach(() => {
  dirs.forEach(d => rmSync(d, { recursive: true, force: true }))
  dirs = []
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'g2cc-pair-'))
  dirs.push(d)
  return join(d, 'home')
}

describe('pairing store', () => {
  test('creates a key once and reuses it', async () => {
    const home = tmp()
    const a = await loadOrCreatePairing(home, { relayUrl: 'ws://127.0.0.1:8787' })
    const b = await loadOrCreatePairing(home)
    expect(a.key.length).toBe(32)
    expect(b.key).toEqual(a.key)
    expect(b.relayUrl).toBe('ws://127.0.0.1:8787')
  })

  test('writes the file and directory owner-only', async () => {
    const home = tmp()
    await loadOrCreatePairing(home, { relayUrl: 'ws://127.0.0.1:8787' })
    expect(statSync(join(home, 'pairing.json')).mode & 0o777).toBe(0o600)
    expect(statSync(home).mode & 0o777).toBe(0o700)
  })

  test('updates the relay URL without changing the key', async () => {
    const home = tmp()
    const a = await loadOrCreatePairing(home, { relayUrl: 'ws://127.0.0.1:8787' })
    const b = await loadOrCreatePairing(home, { relayUrl: 'wss://relay.example.workers.dev' })
    expect(b.key).toEqual(a.key)
    expect(b.relayUrl).toBe('wss://relay.example.workers.dev')
  })

  test('rotates the key on request', async () => {
    const home = tmp()
    const a = await loadOrCreatePairing(home, { relayUrl: 'ws://127.0.0.1:8787' })
    const b = await loadOrCreatePairing(home, { rotate: true })
    expect(b.key).not.toEqual(a.key)
  })

  test('refuses a corrupt file instead of silently re-keying', async () => {
    const home = tmp()
    await loadOrCreatePairing(home, { relayUrl: 'ws://127.0.0.1:8787' })
    writeFileSync(join(home, 'pairing.json'), '{oops')
    await expect(loadOrCreatePairing(home)).rejects.toThrow()
  })

  test('pairingText decodes back to the same pairing', async () => {
    const home = tmp()
    const p = await loadOrCreatePairing(home, { relayUrl: 'ws://127.0.0.1:8787' })
    const decoded = await decodePairing(await pairingText(p))
    expect(decoded.key).toEqual(p.key)
  })
})

describe('stt key and app URL', () => {
  test('stores the speech-to-text key and keeps it across loads', async () => {
    const home = tmp()
    await loadOrCreatePairing(home, { relayUrl: 'ws://127.0.0.1:8787', sttKey: 'gsk_abcdefghij123' })
    expect((await loadOrCreatePairing(home)).sttKey).toBe('gsk_abcdefghij123')
    const decoded = await decodePairing(await pairingText(await loadOrCreatePairing(home)))
    expect(decoded.sttKey).toBe('gsk_abcdefghij123')
  })

  test('derives the app URL from a deployed relay', () => {
    expect(appUrlFor('wss://atillasaadat.com/g2-claude')).toBe('https://atillasaadat.com/g2-claude/app/')
    expect(appUrlFor('wss://relay.example.workers.dev/')).toBe('https://relay.example.workers.dev/app/')
    expect(appUrlFor('ws://127.0.0.1:8789')).toBeNull()
  })
})
