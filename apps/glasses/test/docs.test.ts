// Keeps the user-facing docs in step: the README, the website and the in-app
// guide must agree on how to install and launch, and the changelog must cover
// the versions in app.json and plugin.json.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GUIDE_HTML } from '../src/guide'

const ROOT = join(import.meta.dir, '..', '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const DOCS = {
  README: read('README.md'),
  website: read('relay/public/g2-claude/index.html'),
  guide: GUIDE_HTML,
}

const LAUNCH = "alias cc-g2='claude --dangerously-load-development-channels plugin:g2@g2cc'"

describe('user docs agree', () => {
  for (const [name, text] of Object.entries(DOCS)) {
    test(`${name} has the current install steps and launch command`, () => {
      for (const needle of ['/plugin marketplace add atillasaadat/g2_claude_rc', '/plugin install g2@g2cc', LAUNCH, '/g2:pair', '/g2:setup'])
        expect(text).toContain(needle)
    })

    test(`${name} has nothing from older setups`, () => {
      for (const stale of ['server:g2 --rc', "g2@g2cc --rc'", 'pair.ts --relay', 'scan the QR', 'Exit app. On a card'])
        expect(text).not.toContain(stale)
    })
  }

  test('CLAUDE.md shows the same launch command', () => {
    expect(read('CLAUDE.md')).toContain(LAUNCH)
  })

  test('the changelog covers the current app and plugin versions', () => {
    const log = read('CHANGELOG.md')
    const app = JSON.parse(read('apps/glasses/app.json')).version
    const plugin = JSON.parse(read('plugin/.claude-plugin/plugin.json')).version
    expect(log).toContain(`## App ${app}\n`)
    expect(log).toContain(`## Plugin ${plugin}\n`)
  })
})
