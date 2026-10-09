import { describe, expect, test } from 'bun:test'
import { pairCodeFromQrText } from '../src/qr-scan'

describe('pairing QR text', () => {
  test('accepts the G2CC: form and a bare code, in any case', () => {
    expect(pairCodeFromQrText('G2CC:ABCD-EFGH')).toBe('ABCD-EFGH')
    expect(pairCodeFromQrText('g2cc:abcdefgh')).toBe('ABCD-EFGH')
    expect(pairCodeFromQrText(' ABCD EFGH ')).toBe('ABCD-EFGH')
  })

  test('rejects anything else', () => {
    for (const t of ['https://example.com', 'G2CC:ABC', 'hello world', '']) expect(pairCodeFromQrText(t)).toBeNull()
  })
})
