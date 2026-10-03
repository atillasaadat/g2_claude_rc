#!/usr/bin/env bun
// Claude Code `type: "command"` hook for every g2 hook event. Forwards the
// payload on stdin to this session's channel over its private Unix socket
// (src/hook-socket.ts) and prints the channel's answer. Always exits 0 and
// prints nothing on any failure, so it fails open.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { forwardHook } from './src/hook-socket'

const home = process.env.G2CC_HOME ?? join(homedir(), '.g2cc')
const out = await forwardHook(await Bun.stdin.text(), home)
if (out) process.stdout.write(out)
process.exit(0)
