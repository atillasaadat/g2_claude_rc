import { describe, expect, test } from 'bun:test'
import { clip, oneLine, redact } from '../src/redact'

describe('redact', () => {
  test.each([
    ['openai', 'key sk-proj-abcdefghijklmnop1234567890'],
    ['anthropic', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'],
    ['groq', 'GROQ=gsk_abcdefghijklmnopqrstuvwx123456'],
    ['github', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github fine-grained', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop'],
    ['slack', 'xoxb-123456789012-abcdefghijkl'],
    ['aws', 'AKIAABCDEFGHIJKLMNOP'],
    ['google', 'AIzaSyA-abcdefghijklmnopqrstuvwxyz12345'],
    ['stripe', 'sk_live_abcdefghijklmnopqrstuvwx'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop'],
  ])('masks %s tokens', (_name, text) => {
    const out = redact(text)
    expect(out).toContain('[REDACTED]')
    expect(out).not.toMatch(/abcdefghijklmnop|ABCDEFGHIJKLMNOP|abcdefghijkl/)
  })

  test('masks bearer tokens and keeps the scheme', () => {
    expect(redact('curl -H "Authorization: Bearer abc.def-123456789"')).toBe('curl -H "Authorization: Bearer [REDACTED]"')
  })

  test.each([
    ['PASSWORD=hunter2', 'PASSWORD=[REDACTED]'],
    ['export API_KEY="abc123"', 'export API_KEY="[REDACTED]"'],
    ["--token 'xyz'", "--token '[REDACTED]'"],
    ['client_secret: s3cr3t', 'client_secret: [REDACTED]'],
    ['mysql -u root --password=topsecret db', 'mysql -u root --password=[REDACTED] db'],
  ])('masks secret-named assignments: %s', (input, expected) => {
    expect(redact(input)).toBe(expected)
  })

  test('masks Authorization header values with any scheme', () => {
    expect(redact('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: Basic [REDACTED]')
    expect(redact('Authorization: token abcd1234')).toBe('Authorization: token [REDACTED]')
    expect(redact('authorization: rawvalue99')).toBe('authorization: [REDACTED]')
  })

  test('does not treat everyday words as auth schemes', () => {
    expect(redact('basic usage and token parsing')).toBe('basic usage and token parsing')
  })

  test('masks private key blocks', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----'
    expect(redact(`key:\n${pem}\nend`)).toBe('key:\n[REDACTED PRIVATE KEY]\nend')
  })

  test('masks credentials in URLs', () => {
    expect(redact('git clone https://user:pa55@github.com/x.git')).toBe('git clone https://user:[REDACTED]@github.com/x.git')
  })

  test('leaves ordinary text alone', () => {
    const text = 'git commit -m "fix: token parsing" && ls -la src/ && echo 9b31a03c'
    expect(redact(text)).toBe(text)
  })
})

describe('oneLine', () => {
  test('collapses whitespace and strips control characters', () => {
    expect(oneLine('a\n  b\tc\u0007\u001b[31md')).toBe('a b c[31md')
  })
})

describe('clip', () => {
  test('truncates with an ellipsis', () => {
    expect(clip('abcdef', 4)).toBe('abc…')
    expect(clip('abc', 4)).toBe('abc')
  })
})
