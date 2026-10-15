import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHECK_EVERY_MS, isNewer, updateNotice } from '../src/version-check'

const NOW = 1_800_000_000_000
let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})
const home = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'g2cc-vc-'))
  dirs.push(d)
  return d
}
const manifest = (version: string): Response => Response.json({ name: 'g2', version })

describe('isNewer', () => {
  test('compares versions part by part', () => {
    expect(isNewer('0.4.10', '0.4.9')).toBe(true)
    expect(isNewer('0.5.0', '0.4.9')).toBe(true)
    expect(isNewer('0.4.4', '0.4.4')).toBe(false)
    expect(isNewer('0.4.3', '0.4.4')).toBe(false)
    expect(isNewer('garbage', '0.4.4')).toBe(false)
  })
})

describe('updateNotice', () => {
  test('says how to update when a newer release is out', async () => {
    const msg = await updateNotice({ installed: '0.4.3', home: home(), now: NOW, fetch: async () => manifest('0.4.4') })
    expect(msg).toContain('0.4.4')
    expect(msg).toContain('0.4.3')
    expect(msg).toContain('/plugin marketplace update g2cc')
    const auto = await updateNotice({ installed: '0.4.3', home: home(), now: NOW, fetch: async () => manifest('0.4.4'), selfUpdates: true })
    expect(auto).toContain('switches to it once idle')
    expect(msg).toContain('auto-update')
  })

  test('says nothing when up to date, offline, or answered with junk', async () => {
    expect(await updateNotice({ installed: '0.4.4', home: home(), now: NOW, fetch: async () => manifest('0.4.4') })).toBe('')
    expect(await updateNotice({ installed: '0.4.4', home: home(), now: NOW, fetch: async () => { throw new Error('offline') } })).toBe('')
    expect(await updateNotice({ installed: '0.4.4', home: home(), now: NOW, fetch: async () => new Response('<html>') })).toBe('')
    expect(await updateNotice({ installed: '0.4.4', home: home(), now: NOW, fetch: async () => manifest('9.9.9; rm -rf') })).toBe('')
  })

  test('asks GitHub at most once per period, and remembers the answer', async () => {
    const h = home()
    let calls = 0
    const fetch = async () => {
      calls += 1
      return manifest('0.5.0')
    }
    expect(await updateNotice({ installed: '0.4.4', home: h, now: NOW, fetch })).toContain('0.5.0')
    expect(await updateNotice({ installed: '0.4.4', home: h, now: NOW + 60_000, fetch })).toContain('0.5.0')
    expect(calls).toBe(1)
    await updateNotice({ installed: '0.4.4', home: h, now: NOW + CHECK_EVERY_MS + 1, fetch })
    expect(calls).toBe(2)
    expect(JSON.parse(readFileSync(join(h, 'latest-version.json'), 'utf8')).latest).toBe('0.5.0')
  })

  test('a damaged cache file is ignored', async () => {
    const h = home()
    writeFileSync(join(h, 'latest-version.json'), '{nope')
    expect(await updateNotice({ installed: '0.4.4', home: h, now: NOW, fetch: async () => manifest('0.4.5') })).toContain('0.4.5')
  })

  test('G2CC_NO_UPDATE_CHECK turns it off', async () => {
    let called = false
    const msg = await updateNotice({ installed: '0.1.0', home: home(), now: NOW, disabled: true, fetch: async () => ((called = true), manifest('0.9.0')) })
    expect([msg, called]).toEqual(['', false])
  })
})
