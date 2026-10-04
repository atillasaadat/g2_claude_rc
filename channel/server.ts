#!/usr/bin/env bun
// g2 channel: spawned by Claude Code over stdio. See CLAUDE.md and
// docs/decisions.md. Installed as the g2 plugin and launched with:
//   claude --dangerously-load-development-channels plugin:g2@g2cc   (add --rc for Remote Control)
// From source (scripts/make-sandbox.sh): server:g2 in place of plugin:g2@g2cc.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { runChannel } from './src/channel'
import { loadConfig } from './src/config'

const channel = await runChannel(loadConfig(), new StdioServerTransport())

const shutdown = (): void => {
  void channel.stop().finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
// Claude Code closing stdin means the session ended.
process.stdin.on('end', shutdown)
