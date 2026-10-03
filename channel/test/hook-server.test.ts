import { afterEach, describe, expect, test } from 'bun:test'
import { startHookServer, type HookServer } from '../src/hook-server'

let server: HookServer | null = null
afterEach(() => {
  server?.stop()
  server = null
})

function start(onHook = (_p: Record<string, unknown>) => ({})) {
  server = startHookServer({ port: 0, onHook })
  return `http://127.0.0.1:${server.port}`
}

const post = (url: string, body: string, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
  fetch(`${url}/hook`, { method: 'POST', body, headers })

describe('hook server', () => {
  test('passes JSON payloads to onHook and returns its response', async () => {
    const seen: unknown[] = []
    const url = start(p => {
      seen.push(p)
      return { continue: false }
    })
    const res = await post(url, JSON.stringify({ hook_event_name: 'PreToolUse' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ continue: false })
    expect(seen).toEqual([{ hook_event_name: 'PreToolUse' }])
  })

  test('binds to 127.0.0.1 only', () => {
    start()
    expect(server!.hostname).toBe('127.0.0.1')
  })

  test('rejects non-JSON content types so browsers must preflight', async () => {
    const url = start()
    expect((await post(url, '{}', { 'Content-Type': 'text/plain' })).status).toBe(415)
  })

  test('rejects foreign Host headers (DNS rebinding)', async () => {
    const url = start()
    const res = await post(url, '{}', { 'Content-Type': 'application/json', Host: 'evil.example:27183' })
    expect(res.status).toBe(403)
  })

  test('rejects malformed bodies, non-objects, and other routes', async () => {
    const url = start()
    expect((await post(url, 'not json')).status).toBe(400)
    expect((await post(url, '[1,2]')).status).toBe(400)
    expect((await fetch(`${url}/hook`)).status).toBe(404)
    expect((await fetch(`${url}/other`, { method: 'POST' })).status).toBe(404)
  })

  test('answers 500 when the handler throws, which Claude Code treats as fail-open', async () => {
    const url = start(() => {
      throw new Error('boom')
    })
    expect((await post(url, '{}')).status).toBe(500)
  })

  test('throws when the port is taken', () => {
    start()
    expect(() => startHookServer({ port: server!.port, onHook: () => ({}) })).toThrow()
  })
})
