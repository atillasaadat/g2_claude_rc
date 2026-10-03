import { describe, expect, test } from 'bun:test'
import { relayPairUrl, relayRoomUrl } from '@g2cc/protocol'
import { loadConfig } from '../src/config'

describe('loadConfig', () => {
  test('defaults', () => {
    const c = loadConfig({ CLAUDE_PROJECT_DIR: '/home/u/my-repo' })
    expect(c.sessionName).toBe('my-repo')
    expect(c.home.endsWith('.g2cc')).toBe(true)
    expect(c.sessionId).toBeUndefined()
    expect(c.relayUrlOverride).toBeUndefined()
  })

  test('reads overrides from the environment', () => {
    const c = loadConfig({ G2CC_HOME: '/tmp/g', CLAUDE_CODE_SESSION_ID: 'abc', G2CC_RELAY_URL: 'wss://r.example' })
    expect(c).toMatchObject({ home: '/tmp/g', sessionId: 'abc', relayUrlOverride: 'wss://r.example' })
  })

})

describe('relay URLs', () => {
  test('build key and pairing room URLs and tolerate a trailing slash', () => {
    expect(relayRoomUrl('wss://r.example/', 'a'.repeat(32), 'computer', 'tok')).toBe(`wss://r.example/v1/room/${'a'.repeat(32)}?role=computer&auth=tok`)
    expect(relayPairUrl('wss://r.example', 'b'.repeat(32), 'glasses')).toBe(`wss://r.example/v1/pair/${'b'.repeat(32)}?role=glasses`)
  })
})
