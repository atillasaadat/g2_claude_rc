import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHookServer, type HookServer } from '../src/hook-server'
import { SessionRegistry, routeHook } from '../src/router'

let dirs: string[] = []
let servers: HookServer[] = []
afterEach(() => {
  servers.forEach(s => s.stop())
  servers = []
  dirs.forEach(d => rmSync(d, { recursive: true, force: true }))
  dirs = []
})
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'g2cc-reg-'))
  dirs.push(d)
  return d
}

describe('SessionRegistry', () => {
  test('registers, looks up, and unregisters sessions in an owner-only directory', () => {
    const reg = new SessionRegistry(home())
    reg.register('sess-a', 40001)
    expect(reg.lookup('sess-a')).toEqual({ sid: 'sess-a', port: 40001, pid: process.pid })
    expect(statSync(reg.dir).mode & 0o777).toBe(0o700)
    reg.unregister('sess-a')
    expect(reg.lookup('sess-a')).toBeNull()
  })

  test('ignores entries whose process is gone, and rejects unsafe ids', () => {
    const reg = new SessionRegistry(home())
    reg.register('sess-b', 40002, 2_147_483_000) // no such pid
    expect(reg.lookup('sess-b')).toBeNull()
    expect(() => reg.register('../evil', 1)).toThrow()
    expect(reg.lookup('../evil')).toBeNull()
  })
})

describe('routeHook', () => {
  test('handles its own session locally', async () => {
    const reg = new SessionRegistry(home())
    const r = await routeHook({ session_id: 'mine', hook_event_name: 'PreToolUse' }, { ownSid: 'mine', local: () => ({ continue: false }), registry: reg })
    expect(r).toEqual({ continue: false })
  })

  test('forwards another session to its registered port and returns its answer', async () => {
    const reg = new SessionRegistry(home())
    const seen: unknown[] = []
    const other = startHookServer({ port: 0, onHook: p => (seen.push(p), { hookSpecificOutput: { permissionDecision: 'deny' } }) })
    servers.push(other)
    reg.register('theirs', other.port)
    const r = await routeHook({ session_id: 'theirs', hook_event_name: 'PreToolUse' }, { ownSid: 'mine', local: () => ({}), registry: reg })
    expect(r).toEqual({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(seen).toEqual([{ session_id: 'theirs', hook_event_name: 'PreToolUse' }])
  })

  test('fails open for unknown or unreachable sessions', async () => {
    const reg = new SessionRegistry(home())
    expect(await routeHook({ session_id: 'nobody' }, { ownSid: 'mine', local: () => ({ x: 1 }), registry: reg })).toEqual({})
    reg.register('dead-port', 1)
    expect(await routeHook({ session_id: 'dead-port' }, { ownSid: 'mine', local: () => ({}), registry: reg, timeoutMs: 300 })).toEqual({})
  })
})
