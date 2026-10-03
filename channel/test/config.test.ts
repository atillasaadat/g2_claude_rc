import { describe, expect, test } from 'bun:test'
import { DEFAULT_PORT, loadConfig, relaySocketUrl } from '../src/config'

describe('loadConfig', () => {
  test('defaults', () => {
    const c = loadConfig({ CLAUDE_PROJECT_DIR: '/home/u/my-repo' })
    expect(c.port).toBe(DEFAULT_PORT)
    expect(c.sessionName).toBe('my-repo')
    expect(c.home.endsWith('.g2cc')).toBe(true)
    expect(c.sessionId).toBeUndefined()
    expect(c.relayUrlOverride).toBeUndefined()
  })

  test('reads overrides from the environment', () => {
    const c = loadConfig({ G2CC_PORT: '30001', G2CC_HOME: '/tmp/g', CLAUDE_CODE_SESSION_ID: 'abc', G2CC_RELAY_URL: 'wss://r.example' })
    expect(c).toMatchObject({ port: 30001, home: '/tmp/g', sessionId: 'abc', relayUrlOverride: 'wss://r.example' })
  })

  test.each(['abc', '70000', '-1', '1.5'])('rejects G2CC_PORT=%p', port => {
    expect(() => loadConfig({ G2CC_PORT: port })).toThrow()
  })
})

describe('relaySocketUrl', () => {
  test('builds the room URL and tolerates a trailing slash', () => {
    expect(relaySocketUrl('wss://r.example/', 'a'.repeat(32), 'computer')).toBe(`wss://r.example/v1/room/${'a'.repeat(32)}?role=computer`)
  })
})
