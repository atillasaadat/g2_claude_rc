import { describe, expect, test } from 'bun:test'
import {
  C2G_KINDS,
  G2C_KINDS,
  REQUEST_ID_RE,
  makeEnvelope,
  parseEnvelope,
  type Kind,
} from '../src/envelope'
import { GLANCE_MAX } from '../src/limits'

const samples: Record<Kind, unknown> = {
  session: { name: 'repo', cwd: '/home/u/repo', state: 'working', mode: 'auto' },
  event: { type: 'tool_start', tool: 'Bash', summary: 'ls -la' },
  reply: { text: 'Done.' },
  glance: { text: 'Tests pass' },
  permission: { request_id: 'abcde', tool_name: 'Bash', description: 'Run shell command', input_preview: '{}' },
  permission_resolved: { request_id: 'abcde' },
  question: { question_id: 'q1', question: 'Which branch?', options: ['main', 'dev'] },
  prompt: { text: 'run the tests' },
  verdict: { request_id: 'abcde', behavior: 'allow' },
  answer: { question_id: 'q1', choice: 'main' },
  stop: {},
}

describe('REQUEST_ID_RE', () => {
  test('accepts five letters from a-z without l', () => {
    expect(REQUEST_ID_RE.test('abcde')).toBe(true)
    expect(REQUEST_ID_RE.test('wokkv')).toBe(true)
  })
  test.each(['abcdl', 'ABCDE', 'abcd', 'abcdef', 'abc1e', ' abcde', ''])('rejects %p', id => {
    expect(REQUEST_ID_RE.test(id)).toBe(false)
  })
})

describe('direction sets', () => {
  test('partition every kind exactly once', () => {
    const all: string[] = [...C2G_KINDS, ...G2C_KINDS].sort()
    expect(all).toEqual(Object.keys(samples).sort())
  })
})

describe('parseEnvelope', () => {
  test.each(Object.entries(samples))('accepts a valid %s in its direction', (kind, body) => {
    const dir = (C2G_KINDS as readonly string[]).includes(kind) ? 'c2g' : 'g2c'
    const env = makeEnvelope(kind as Kind, body as never)
    expect(parseEnvelope(env, dir)).toEqual(env)
  })

  test('rejects a computer-bound kind arriving from the computer side', () => {
    const env = makeEnvelope('verdict', { request_id: 'abcde', behavior: 'allow' })
    expect(() => parseEnvelope(env, 'c2g')).toThrow()
  })

  test('rejects a glasses-bound kind arriving from the glasses side', () => {
    const env = makeEnvelope('permission', samples.permission as never)
    expect(() => parseEnvelope(env, 'g2c')).toThrow()
  })

  test('rejects unknown kinds, wrong version, and extra fields in bodies', () => {
    const base = makeEnvelope('stop', {})
    expect(() => parseEnvelope({ ...base, kind: 'exec' }, 'g2c')).toThrow()
    expect(() => parseEnvelope({ ...base, v: 2 }, 'g2c')).toThrow()
    expect(() => parseEnvelope({ ...base, body: { force: true } }, 'g2c')).toThrow()
  })

  test('rejects a verdict with a malformed request id or behavior', () => {
    const env = makeEnvelope('verdict', { request_id: 'abcde', behavior: 'allow' })
    expect(() => parseEnvelope({ ...env, body: { request_id: 'abcdl', behavior: 'allow' } }, 'g2c')).toThrow()
    expect(() => parseEnvelope({ ...env, body: { request_id: 'abcde', behavior: 'yes' } }, 'g2c')).toThrow()
  })

  test('limits question options to 1..4', () => {
    const env = makeEnvelope('question', samples.question as never)
    expect(() => parseEnvelope({ ...env, body: { question_id: 'q', question: 'q?', options: [] } }, 'c2g')).toThrow()
    const five = ['a', 'b', 'c', 'd', 'e']
    expect(() => parseEnvelope({ ...env, body: { question_id: 'q', question: 'q?', options: five } }, 'c2g')).toThrow()
  })

  test('limits glance length', () => {
    const env = makeEnvelope('glance', { text: 'x' })
    expect(() => parseEnvelope({ ...env, body: { text: 'x'.repeat(GLANCE_MAX + 1) } }, 'c2g')).toThrow()
  })

  test('rejects an empty prompt', () => {
    const env = makeEnvelope('prompt', { text: 'x' })
    expect(() => parseEnvelope({ ...env, body: { text: '' } }, 'g2c')).toThrow()
  })
})

describe('makeEnvelope', () => {
  test('fills v, a unique id, and ts', () => {
    const a = makeEnvelope('stop', {})
    const b = makeEnvelope('stop', {})
    expect(a.v).toBe(1)
    expect(a.id).not.toBe(b.id)
    expect(Math.abs(a.ts - Date.now())).toBeLessThan(1000)
  })

  test('carries an optional session id', () => {
    const env = makeEnvelope('reply', { text: 'hi' }, { sid: 'b6cb35c4-a08d-4b7c-815b-991d9bd2ade9' })
    expect(parseEnvelope(env, 'c2g').sid).toBe('b6cb35c4-a08d-4b7c-815b-991d9bd2ade9')
  })
})
