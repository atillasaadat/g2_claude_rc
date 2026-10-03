import { describe, expect, test } from 'bun:test'
import { GUIDE_HTML, GUIDE_URL } from '../src/guide'

describe('phone setup guide', () => {
  test('covers the setup steps from the website', () => {
    for (const needle of ['scripts/install.sh', 'cc-g2', 'pair.ts --relay wss://atillasaadat.com/g2-claude --text', 'console.groq.com/keys', 'inputNeededNotifEnabled', GUIDE_URL]) {
      expect(GUIDE_HTML).toContain(needle)
    }
  })

  test('follows the writing rule (no em dashes) and has no scripts', () => {
    expect(GUIDE_HTML).not.toContain('—')
    expect(GUIDE_HTML.toLowerCase()).not.toContain('<script')
  })
})
