import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forwardHook, isPrivateDir, startHookSocket, type HookSocket } from '../src/hook-socket'

const SID = '0f6c2a52-1b7e-4b0e-9f53-3d0f3f1e2a11'
let dirs: string[] = []
let socks: HookSocket[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'g2s-'))
  dirs.push(d)
  return join(d, 'home')
}
afterEach(() => {
  for (const s of socks) s.stop()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  socks = []
  dirs = []
})
const payload = (extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', ...extra })

describe('hook socket', () => {
  test('forwards a payload to its session and returns the decision', async () => {
    const home = tmp()
    socks.push(startHookSocket({ home, sid: SID, onHook: p => ({ seen: p.hook_event_name }) }))
    expect(await forwardHook(payload(), home)).toBe('{"seen":"PreToolUse"}')
  })

  test('"no decision" prints nothing', async () => {
    const home = tmp()
    socks.push(startHookSocket({ home, sid: SID, onHook: () => ({}) }))
    expect(await forwardHook(payload(), home)).toBe('')
  })

  test('fails open: no socket, bad session id, bad JSON, or a handler error', async () => {
    const home = tmp()
    expect(await forwardHook(payload(), home)).toBe('')
    socks.push(startHookSocket({ home, sid: SID, onHook: () => { throw new Error('x') } }))
    expect(await forwardHook(payload(), home)).toBe('')
    expect(await forwardHook(JSON.stringify({ session_id: '../../etc' }), home)).toBe('')
    expect(await forwardHook('not json', home)).toBe('')
  })

  test('refuses a home that others can open, or that is a symlink', async () => {
    const home = tmp()
    socks.push(startHookSocket({ home, sid: SID, onHook: () => ({ ok: true }) }))
    chmodSync(home, 0o755)
    expect(isPrivateDir(home)).toBe(false)
    expect(await forwardHook(payload(), home)).toBe('')
    chmodSync(home, 0o700)
    const link = join(dirs[0]!, 'link')
    symlinkSync(home, link)
    expect(await forwardHook(payload(), link)).toBe('')
  })

  test('the sessions directory and socket are private', async () => {
    const home = tmp()
    const s = startHookSocket({ home, sid: SID, onHook: () => ({}) })
    socks.push(s)
    expect(isPrivateDir(home)).toBe(true)
    expect(isPrivateDir(join(home, 'sessions'))).toBe(true)
    expect(((await Bun.file(s.path).stat()).mode & 0o077)).toBe(0)
  })

  test('replaces a stale socket left by a crash, and removes it on stop', async () => {
    const home = tmp()
    mkdirSync(join(home, 'sessions'), { recursive: true, mode: 0o700 })
    const first = startHookSocket({ home, sid: SID, onHook: () => ({ n: 1 }) })
    const second = startHookSocket({ home, sid: SID, onHook: () => ({ n: 2 }) })
    socks.push(second)
    expect(await forwardHook(payload(), home)).toBe('{"n":2}')
    first.stop() // an old channel going away must not remove the new socket
    expect(await forwardHook(payload(), home)).toBe('{"n":2}')
    second.stop()
    socks = []
    expect(await forwardHook(payload(), home)).toBe('')
  })
})
