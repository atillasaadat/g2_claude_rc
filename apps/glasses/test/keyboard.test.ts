import { describe, expect, test } from 'bun:test'
import { normalizePairCode } from '@g2cc/protocol'

// The phone view pairs as soon as the typed code is complete (ui.ts).
describe('auto-pair trigger', () => {
  test('fires only once the code is complete, however it is typed', () => {
    for (const partial of ['', 'A', 'ABCD', 'ABCD-', 'ABCD-EFG']) expect(normalizePairCode(partial)).toBeNull()
    for (const full of ['ABCD-EFGH', 'abcdefgh', 'abcd efgh', ' ABCD-EFGH ']) expect(normalizePairCode(full)).toBe('ABCDEFGH')
  })
})
