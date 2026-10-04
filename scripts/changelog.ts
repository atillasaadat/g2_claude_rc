#!/usr/bin/env bun
// Prints one CHANGELOG.md entry as plain text, for Even Hub's release notes
// field (or anywhere that does not render Markdown).
//
//   bun scripts/changelog.ts app 0.3.7
//   bun scripts/changelog.ts plugin 0.3.3

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [kind, version] = process.argv.slice(2)
if (!kind || !version || !/^(app|plugin)$/.test(kind)) {
  console.error('usage: bun scripts/changelog.ts app|plugin X.Y.Z')
  process.exit(1)
}
const heading = `## ${kind === 'app' ? 'App' : 'Plugin'} ${version}`
const log = readFileSync(join(import.meta.dir, '..', 'CHANGELOG.md'), 'utf8').split('\n')
const start = log.indexOf(heading)
if (start < 0) {
  console.error(`no "${heading}" entry in CHANGELOG.md`)
  process.exit(1)
}
const end = log.findIndex((l, i) => i > start && l.startsWith('## '))
const body = log.slice(start + 1, end < 0 ? undefined : end)
const plain = body
  .map(l => l.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'))
  .join('\n')
  .trim()
console.log(plain)
