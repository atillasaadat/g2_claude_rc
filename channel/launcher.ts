#!/usr/bin/env bun
// The g2 plugin's MCP server entry (plugin/dist/server.js). It runs the
// channel (plugin/dist/channel.js) as a child and can move a running session
// to a newer plugin version; see src/launcher.ts.

import { dirname, join } from 'node:path'
import { Launcher, type Child } from './src/launcher'

const log = (msg: string): void => {
  process.stderr.write(`g2 launcher: ${msg}\n`)
}

// Bundled as <plugin root>/dist/server.js.
const ownRoot = process.env.CLAUDE_PLUGIN_ROOT ?? join(dirname(import.meta.path), '..')

function spawnChannel(root: string): Child {
  const proc = Bun.spawn(['bun', join(root, 'dist', 'channel.js')], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, G2CC_LAUNCHER: '1' },
  })
  const lineCbs: Array<(l: string) => void> = []
  void (async () => {
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        for (const cb of lineCbs) cb(line)
      }
    }
  })()
  return {
    write: line => {
      try {
        proc.stdin.write(line + '\n')
        void proc.stdin.flush()
      } catch {
        // The channel is gone; its exit is handled.
      }
    },
    onLine: cb => void lineCbs.push(cb),
    onExit: cb => void proc.exited.then(code => cb(code)),
    signal: sig => proc.kill(sig),
    closeInput: () => {
      try {
        void proc.stdin.end()
      } catch {
        proc.kill('SIGTERM')
      }
    },
  }
}

const launcher = new Launcher(ownRoot, {
  spawn: spawnChannel,
  out: line => process.stdout.write(line + '\n'),
  exit: code => process.exit(code),
  log,
  now: Date.now,
})

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => launcher.end(sig))

const dec = new TextDecoder()
let buf = ''
process.stdin.on('data', (chunk: Buffer) => {
  buf += dec.decode(chunk, { stream: true })
  let i: number
  while ((i = buf.indexOf('\n')) >= 0) {
    launcher.fromParent(buf.slice(0, i))
    buf = buf.slice(i + 1)
  }
})
// Claude Code closing stdin means the session ended.
process.stdin.on('end', () => launcher.end())
