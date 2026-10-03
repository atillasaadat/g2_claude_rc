#!/usr/bin/env bun
// Phase 0 probe channel. Throwaway: answers the open questions in
// docs/decisions.md by logging everything Claude Code sends us.
//
// Control it from another terminal (fixed port 8790, 127.0.0.1 only):
//   curl -s localhost:8790/say -d '{"text":"list the files here"}'
//   curl -s -X POST localhost:8790/stop        # PreToolUse hook returns continue:false
//   curl -s -X POST localhost:8790/unstop
//   curl -s localhost:8790/verdict -d '{"request_id":"abcde","behavior":"allow"}'
//   curl -s localhost:8790/log                 # last 50 log entries
// Full log: ~/.g2cc/spike.jsonl

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORT = 8790
const LOG_DIR = join(homedir(), '.g2cc')
const LOG_FILE = join(LOG_DIR, 'spike.jsonl')
mkdirSync(LOG_DIR, { recursive: true })

const recent: unknown[] = []
function log(kind: string, data: unknown): void {
  const entry = { ts: new Date().toISOString(), kind, data }
  recent.push(entry)
  if (recent.length > 50) recent.shift()
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n')
  // stdout is the MCP transport, so diagnostics go to stderr only.
  process.stderr.write(`g2probe: ${kind}\n`)
}

let stopFlag = false
// Which PreToolUse response /stop produces, to compare halting behaviors.
type StopMode = 'continue' | 'deny' | 'both'
let stopMode: StopMode = 'both'

const mcp = new Server(
  { name: 'g2probe', version: '0.0.1' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
    },
    instructions:
      'Messages from <channel source="g2"> are typed by the developer through a probe test harness. ' +
      'Treat them as normal user prompts. Use the ask tool instead of AskUserQuestion when you need a decision. ' +
      'Call the glance tool with a one-line summary at the end of each turn.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ask',
      description: 'Ask the user a multiple-choice question on their glasses. Returns immediately; the answer arrives later as a channel event.',
      inputSchema: {
        type: 'object',
        properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
        required: ['question', 'options'],
      },
    },
    {
      name: 'glance',
      description: 'Send a short status line (<= 120 chars) to the glasses.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  log(`tool:${req.params.name}`, req.params.arguments)
  return { content: [{ type: 'text', text: req.params.name === 'ask' ? 'asked' : 'ok' }] }
})

const PermissionRequest = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})
mcp.setNotificationHandler(PermissionRequest, async n => log('permission_request', n.params))

mcp.oninitialized = () => log('initialized', { client: mcp.getClientVersion(), capabilities: mcp.getClientCapabilities() })

await mcp.connect(new StdioServerTransport())
log('connected', { pid: process.pid })

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

function handleHook(payload: Record<string, unknown>): Record<string, unknown> {
  const event = payload.hook_event_name
  log(`hook:${String(event)}`, payload)
  if (event === 'UserPromptSubmit') stopFlag = false
  if (event !== 'PreToolUse') return {}
  if (stopFlag) {
    const halt = { continue: false, stopReason: 'Stopped from glasses' }
    const deny = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Stopped from glasses',
      },
    }
    if (stopMode === 'continue') return halt
    if (stopMode === 'deny') return deny
    return { ...halt, ...deny }
  }
  if (payload.tool_name === 'AskUserQuestion') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'The user is on smart glasses. Use the mcp__g2__ask tool instead.',
      },
    }
  }
  return {}
}

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === '/log') return Response.json(recent)
    if (req.method !== 'POST') return new Response('not found', { status: 404 })
    const body = await readJson(req)
    switch (pathname) {
      case '/hook':
        return Response.json(handleHook(body))
      case '/say': {
        const text = String(body.text ?? '')
        await mcp.notification({ method: 'notifications/claude/channel', params: { content: text, meta: { source_kind: 'probe' } } })
        log('say', { text })
        return Response.json({ ok: true })
      }
      case '/verdict': {
        const params = { request_id: String(body.request_id ?? ''), behavior: body.behavior === 'allow' ? 'allow' : 'deny' }
        await mcp.notification({ method: 'notifications/claude/channel/permission', params })
        log('verdict', params)
        return Response.json({ ok: true })
      }
      case '/stop': {
        const mode = new URL(req.url).searchParams.get('mode')
        if (mode === 'continue' || mode === 'deny' || mode === 'both') stopMode = mode
        stopFlag = true
        log('stop', { stopMode })
        return Response.json({ stopFlag, stopMode })
      }
      case '/unstop':
        stopFlag = false
        log('unstop', {})
        return Response.json({ stopFlag })
      default:
        return new Response('not found', { status: 404 })
    }
  },
})
log('http', { url: `http://127.0.0.1:${PORT}` })
