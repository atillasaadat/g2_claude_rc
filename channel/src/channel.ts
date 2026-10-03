// Wires the pieces together: MCP (stdio, to Claude Code), the localhost hook
// server, and the encrypted relay connection to the glasses.
//
// Inbound envelopes from the glasses are decrypted and validated before the
// controller sees them: `stop` (Phase 4) and `verdict` (Phase 5) so far.

import { existsSync } from 'node:fs'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { GLANCE_MAX, SecureChannel, type Body, type C2G_KINDS } from '@g2cc/protocol'
import { DEFAULT_RELAY_URL, relaySocketUrl, type ChannelConfig } from './config'
import { startHookServer, type HookResponse, type HookServer } from './hook-server'
import { SessionController } from './controller'
import type { HookPayload } from './hooks'
import { openCodePairing, type OpenCodePairing } from './code-pairing'
import { loadOrCreatePairing, pairingPath } from './pairing-store'
import { routeHook, SessionRegistry } from './router'
import { clip, oneLine, redact } from './redact'
import { RelayClient } from '@g2cc/protocol'

type C2GKind = (typeof C2G_KINDS)[number]

export const INSTRUCTIONS = [
  'The user may be following this session on Even Realities G2 smart glasses, which show a live feed of your tool calls and your final reply.',
  'Messages wrapped in a <channel> tag whose source is "g2" (or "plugin:g2:g2") were spoken by the user through the glasses and transcribed by speech recognition, so they can contain transcription errors.',
  'Treat them as the user\'s own prompts. If a spoken request is ambiguous, or would do something destructive or hard to undo, confirm with the ask tool before acting.',
  'When you need the user to make a decision, call the ask tool (a question and 2 to 4 short options) instead of AskUserQuestion, then end your turn. The answer arrives as a g2 channel message with a question_id attribute.',
  `At the end of each turn, call the glance tool with a one-line plain-text summary (at most ${GLANCE_MAX} characters) of what you did or what you need from the user.`,
].join(' ')

const ROUTER_RETRY_MS = 3_000

const PermissionRequestNotification = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  // Validated in the controller; display text in it is untrusted.
  params: z.unknown(),
})

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

  let glassesPresent = 0
  const relay: RelayClient = new RelayClient({
    url: relaySocketUrl(pairing.relayUrl, secure.roomId, 'computer'),
    onStatus: s => {
      log(`relay ${s}`)
      if (s === 'open') controller.resync()
      if (s === 'closed') {
        glassesPresent = 0
        controller.setGlassesPresent(false)
      }
    },
    onPresence: p => {
      // A glasses socket joined: re-send state and pending requests with fresh
      // timestamps, since the glasses ignore stale permission cards from history.
      if (p.glasses > glassesPresent) controller.resync()
      glassesPresent = p.glasses
      controller.setGlassesPresent(p.glasses > 0)
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
    sendPrompt: text => {
      // meta keys must be identifiers or Claude Code drops them silently.
      void mcp
        .notification({ method: 'notifications/claude/channel', params: { content: text, meta: { source_kind: 'voice' } } })
        .catch(err => log(`prompt not delivered: ${(err as Error).message}`))
    },
    sendAnswer: (content, questionId) => {
      void mcp
        .notification({
          method: 'notifications/claude/channel',
          params: { content, meta: { question_id: questionId, source_kind: 'answer' } },
        })
        .catch(err => log(`answer not delivered: ${(err as Error).message}`))
    },
    sendVerdict: (request_id, behavior) => {
      void mcp
        .notification({ method: 'notifications/claude/channel/permission', params: { request_id, behavior } })
        .catch(err => log(`verdict not delivered: ${(err as Error).message}`))
    },
  })
  const onHook = (raw: Record<string, unknown>): HookResponse => controller.onHook(raw as HookPayload)

  // Multi-session (src/router.ts): this session's own hooks on a private port,
  // registered by session id; whoever holds the fixed port routes for everyone.
  const registry = new SessionRegistry(cfg.home)
  let own: HookServer | null = null
  if (cfg.sessionId) {
    own = startHookServer({ port: 0, onHook })
    registry.register(cfg.sessionId, own.port)
  }
  let router: HookServer | null = null
  let stopped = false
  const claimRouter = (): void => {
    if (router || stopped) return
    try {
      router = startHookServer({ port: cfg.port, onHook: p => routeHook(p, { ownSid: cfg.sessionId, local: onHook, registry }) })
      log(`routing hooks on 127.0.0.1:${cfg.port}`)
    } catch {
      // Another g2 session routes; it forwards this session's hooks here.
    }
  }
  claimRouter()
  if (!router) log(`another g2 session is routing hooks on ${cfg.port}; this session is reachable through it`)
  // Take over routing if the router's session ends.
  const claimTimer = setInterval(claimRouter, ROUTER_RETRY_MS)

  let pairingCode: OpenCodePairing | null = null

  const mcp = new Server(
    { name: 'g2', version: '0.1.0' },
    {
      capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} },
      instructions: INSTRUCTIONS,
    },
  )
  mcp.setNotificationHandler(PermissionRequestNotification, n => controller.onPermissionRequest(n.params))
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'ask',
        description:
          "Ask the user a multiple-choice question on their smart glasses. Returns immediately; end your turn afterwards. The user's choice arrives later as a channel message with the question_id.",
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Short question, one or two lines.' },
            options: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4, description: '1 to 4 short options.' },
          },
          required: ['question', 'options'],
        },
      },
      {
        name: 'pair',
        description:
          'Show a one-time code for pairing the G2 Claude phone app with this computer. Call it only when the user asks to pair (for example through /g2:pair). Show the user the code exactly as returned.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'glance',
        description: `Show a one-line status (at most ${GLANCE_MAX} characters) on the user's smart glasses. Call it at the end of each turn.`,
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ],
  }))
  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    if (req.params.name === 'ask') {
      const r = controller.onAsk(req.params.arguments)
      return { content: [{ type: 'text', text: r.ok && !relay.isOpen ? `${r.text} (Relay offline: delivered when it reconnects.)` : r.text }], isError: !r.ok }
    }
    if (req.params.name === 'pair') {
      pairingCode?.cancel()
      const open = await openCodePairing(pairing)
      pairingCode = open
      void open.done.then(ok => {
        if (pairingCode === open) pairingCode = null
        log(ok ? 'phone paired by code' : 'pairing code expired')
      })
      const minutes = Math.round((open.expiresAt - Date.now()) / 60_000)
      return {
        content: [
          {
            type: 'text',
            text:
              `Pairing code: ${open.code}\n` +
              `In the G2 Claude app on the phone, open Pairing, type it, and tap Pair. ` +
              `It works once and expires in ${minutes} minutes. Anyone with the code can pair until then, so show it only to the user.`,
          },
        ],
      }
    }
    if (req.params.name !== 'glance') throw new Error(`unknown tool ${req.params.name}`)
    const text = (req.params.arguments as { text?: unknown } | undefined)?.text
    if (typeof text !== 'string' || !text.trim()) throw new Error('glance needs non-empty text')
    emit('glance', { text: clip(oneLine(redact(text)), GLANCE_MAX) })
    return { content: [{ type: 'text', text: relay.isOpen ? 'shown' : 'queued: glasses relay offline' }] }
  })

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    pairingCode?.cancel()
    clearInterval(claimTimer)
    router?.stop()
    own?.stop()
    if (cfg.sessionId) registry.unregister(cfg.sessionId)
    // Tell the glasses this session is gone, so it leaves the session list.
    emit('session', { ...controller.snapshot(), state: 'ended' })
    await outbound
    relay.stop()
    await mcp.close()
  }
  mcp.onclose = () => void stop()

  await mcp.connect(transport)
  relay.start()
  // router is assigned inside claimRouter, which TypeScript cannot see here.
  return { hookPort: (router as HookServer | null)?.port ?? own?.port ?? null, stop }
}
