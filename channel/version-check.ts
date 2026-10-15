#!/usr/bin/env bun
// SessionStart hook: prints a systemMessage when a newer g2 plugin is out
// (src/version-check.ts). Prints nothing on any failure and always exits 0.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { updateNotice } from './src/version-check'

try {
  // Bundled as plugin/dist/version-check.js; the manifest sits beside dist/.
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown }
  const notice =
    typeof manifest.version === 'string'
      ? await updateNotice({
          installed: manifest.version,
          home: process.env.G2CC_HOME ?? join(homedir(), '.g2cc'),
          now: Date.now(),
          fetch: (url, init) => fetch(url, init),
          disabled: Boolean(process.env.G2CC_NO_UPDATE_CHECK),
          selfUpdates: process.env.G2CC_NO_AUTO_UPDATE !== '1',
        })
      : ''
  if (notice) process.stdout.write(JSON.stringify({ systemMessage: notice }))
} catch {
  // Fail quiet.
}
process.exit(0)
