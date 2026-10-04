import { describe, expect, test } from 'bun:test'
import { GUIDE_HTML, GUIDE_URL } from '../src/guide'

describe('phone setup guide', () => {
  test('covers the plugin setup steps', () => {
    for (const needle of [
      '/plugin marketplace add atillasaadat/g2_claude_rc',
      '/plugin install g2@g2cc',
      "plugin:g2@g2cc'",
      '/g2:pair',
      'console.groq.com/keys',
      'inputNeededNotifEnabled',
      GUIDE_URL,
    ]) {
      expect(GUIDE_HTML).toContain(needle)
    }
  })

  test('no longer asks for a clone, an install script, or a QR code', () => {
    for (const gone of ['git clone', 'install.sh', 'QR']) expect(GUIDE_HTML).not.toContain(gone)
  })

  test('follows the writing rule (no em dashes) and has no scripts', () => {
    expect(GUIDE_HTML).not.toContain('—')
    expect(GUIDE_HTML.toLowerCase()).not.toContain('<script')
  })
})
