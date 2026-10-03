// Wires the pieces together: MCP (stdio, to Claude Code), the localhost hook
// server, and the encrypted relay connection to the glasses.
//
// Inbound envelopes from the glasses are decrypted and validated before the
// controller sees them. Phase 4 acts on `stop`; other commands come later.

import { existsSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { GLANCE_MAX, SecureChannel, type Body, type C2G_KINDS } from '@g2cc/protocol'
import { DEFAULT_RELAY_URL, relaySocketUrl, type ChannelConfig } from './config'
import { startHookServer, type HookResponse, type HookServer } from './hook-server'
import { SessionController } from './controller'
import type { HookPayload } from './hooks'
import { loadOrCreatePairing, pairingPath } from './pairing-store'
import { clip, oneLine, redact } from './redact'
import { RelayClient } from '@g2cc/protocol'

type C2GKind = (typeof C2G_KINDS)[number]

export const INSTRUCTIONS = [
  'The user may be following this session on Even Realities G2 smart glasses, which show a live feed of your tool calls and your final reply.',
  `At the end of each turn, call the glance tool with a one-line plain-text summary (at most ${GLANCE_MAX} characters) of what you did or what you need from the user.`,
].join(' ')

const log = (msg: string): void => {
  // stdout is the MCP transport, so diagnostics go to stderr. Never log content.
  process.stderr.write(`g2: ${msg}\n`)
}

export interface RunningChannel {
  readonly hookPort: number | null
  stop(): Promise<void>
}

export async function runChannel(cfg: ChannelConfig, transport: Transport): Promise<RunningChannel> {
  const pairing = await loadOrCreatePairing(cfg.home, {
    relayUrl: cfg.relayUrlOverride ?? (existsSync(pairingPath(cfg.home)) ? undefined : DEFAULT_RELAY_URL),
  })
  const secure = await SecureChannel.create(pairing.key, 'computer')

  // Sealing is async; a promise chain keeps envelopes in hook order.
  let outbound: Promise<void> = Promise.resolve()
  const emit = <K extends C2GKind>(kind: K, body: Body<K>): void => {
    outbound = outbound
      .then(async () => relay.send(await secure.seal(kind, body, cfg.sessionId ? { sid: cfg.sessionId } : {})))
      .catch(err => log(`dropped ${kind}: ${(err as Error).message}`))
  }

  const relay: RelayClient = new RelayClient({
    url: relaySocketUrl(pairing.relayUrl, secure.roomId, 'computer'),
    onStatus: s => {
      log(`relay ${s}`)
      if (s === 'open') emit('session', controller.snapshot())
    },
    onRateLimited: () => log('relay rate limit hit'),
    onFrame: async frame => {
      const env = await secure.open(frame)
      if (!env) return // failed decryption, schema, or replay checks: drop silently
      log(`inbound ${env.kind}`)
      controller.onInbound(env)
    },
  })

  // Only this session's hooks count: others may share the port's settings.json.
  const controller = new SessionController({
    ...(cfg.sessionId ? { sessionId: cfg.sessionId } : {}),
    name: cfg.sessionName,
    cwd: cfg.projectDir,
    emit: e => emit(e.kind, e.body as never),
  })
  const onHook = (raw: Record<string, unknown>): HookResponse => controller.onHook(raw as HookPayload)

  let hooks: HookServer | null = null
  try {
    hooks = startHookServer({ port: cfg.port, onHook })
    log(`hooks on 127.0.0.1:${hooks.port}`)
  } catch {
    log(`port ${cfg.port} is in use (another g2 session?). The feed is off for this session; glance still works.`)
  }

  const mcp = new Server(
    { name: 'g2', version: '0.1.0' },
    { capabilities: { experimental: { 'claude/channel': {} }, tools: {} }, instructions: INSTRUCTIONS },
  )
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'glance',
        description: `Show a one-line status (at most ${GLANCE_MAX} characters) on the user's smart glasses. Call it at the end of each turn.`,
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ],
  }))
  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    if (req.params.name !== 'glance') throw new Error(`unknown tool ${req.params.name}`)
    const text = (req.params.arguments as { text?: unknown } | undefined)?.text
    if (typeof text !== 'string' || !text.trim()) throw new Error('glance needs non-empty text')
    emit('glance', { text: clip(oneLine(redact(text)), GLANCE_MAX) })
    return { content: [{ type: 'text', text: relay.isOpen ? 'shown' : 'queued: glasses relay offline' }] }
  })

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    hooks?.stop()
    await outbound
    relay.stop()
    await mcp.close()
  }
  mcp.onclose = () => void stop()

  await mcp.connect(transport)
  relay.start()
  return { hookPort: hooks?.port ?? null, stop }
}
