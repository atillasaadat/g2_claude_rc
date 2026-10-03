// Turns Claude Code hook payloads into glasses envelopes. Pure functions:
// everything outbound is redacted, flattened, and clipped here.
//
// Payload fields verified in Phase 0 (docs/decisions.md): PreToolUse has
// tool_name and tool_input; PostToolUse adds tool_response (Bash has stdout,
// stderr, interrupted, and no exit code); UserPromptSubmit has prompt (wrapped
// in <channel source="g2"> or source="plugin:g2:g2" for channel messages);
// Notification has message and notification_type; Stop has last_assistant_message.

import { relative, isAbsolute } from 'node:path'
import type { Body } from '@g2cc/protocol'
import { TEXT_MAX } from '@g2cc/protocol'
import { clip, oneLine, redact } from './redact'

export const SUMMARY_MAX = 200

export interface HookPayload {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  permission_mode?: string
  tool_name?: string
  tool_input?: unknown
  tool_response?: unknown
  prompt?: string
  message?: string
  notification_type?: string
  last_assistant_message?: string
}

export type Outbound = { kind: 'event'; body: Body<'event'> } | { kind: 'reply'; body: Body<'reply'> }

type SessionBody = Body<'session'>

/**
 * Plumbing that would only clutter a 4-line feed: tool discovery, and our own
 * channel tools (glance arrives as its own envelope).
 */
function isHiddenTool(name: string): boolean {
  return name === 'ToolSearch' || /^mcp__(?:plugin_g2_)?g2__/.test(name)
}

/**
 * Our display-only tools: `mcp__g2__*` as a plain MCP server and
 * `mcp__plugin_g2_g2__*` from the plugin. `pair` is not one of them: it hands
 * out a pairing code, so it keeps the normal permission prompt.
 */
export const G2_TOOL = /^mcp__(?:plugin_g2_)?g2__(?:ask|glance)$/

/** The source tag is "g2" as a plain MCP server and "plugin:g2:g2" from the plugin. */
const CHANNEL_WRAPPER = /^<channel source="(?:plugin:g2:)?g2"[^>]*>\n?([\s\S]*?)\n?<\/channel>\s*$/

const summary = (text: string): string => clip(oneLine(redact(text)), SUMMARY_MAX)

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

function displayPath(path: string, cwd: string | undefined): string {
  if (!cwd || !isAbsolute(path)) return path
  const rel = relative(cwd, path)
  return rel.startsWith('..') ? path : rel
}

/** `mcp__server__tool` becomes `server:tool`. */
function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${m[1]}:${m[2]}` : name
}

function startSummary(tool: string, input: unknown, cwd: string | undefined): string {
  const path = field(input, 'file_path') ?? field(input, 'notebook_path')
  switch (tool) {
    case 'Bash':
      return field(input, 'command') ?? tool
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return path ? displayPath(path, cwd) : tool
    case 'Grep': {
      const pattern = field(input, 'pattern') ?? ''
      const where = field(input, 'path')
      return where ? `"${pattern}" in ${where}` : `"${pattern}"`
    }
    case 'Glob':
      return field(input, 'pattern') ?? tool
    case 'WebFetch': {
      const url = field(input, 'url')
      if (!url) return tool
      try {
        const u = new URL(url)
        return `${u.host}${u.pathname}`
      } catch {
        return url
      }
    }
    case 'WebSearch':
      return field(input, 'query') ?? tool
    case 'Task':
    case 'Agent':
      return field(input, 'description') ?? tool
    default:
      return toolLabel(tool)
  }
}

function endSummary(tool: string, input: unknown, response: unknown, cwd: string | undefined): string {
  if (tool === 'Bash') {
    if (typeof response === 'object' && response !== null && (response as { interrupted?: unknown }).interrupted === true) {
      return 'interrupted'
    }
    const stderr = field(response, 'stderr')?.split('\n').find(l => l.trim())
    return stderr ? `ok, stderr: ${stderr}` : 'ok'
  }
  const path = field(input, 'file_path')
  if (path && (tool === 'Edit' || tool === 'MultiEdit')) return `edited ${displayPath(path, cwd)}`
  if (path && tool === 'Write') return `wrote ${displayPath(path, cwd)}`
  return 'done'
}

export function translateHook(p: HookPayload): Outbound[] {
  switch (p.hook_event_name) {
    case 'PreToolUse': {
      if (!p.tool_name || isHiddenTool(p.tool_name)) return []
      const tool = toolLabel(p.tool_name)
      return [{ kind: 'event', body: { type: 'tool_start', tool, summary: summary(startSummary(p.tool_name, p.tool_input, p.cwd)) } }]
    }
    case 'PostToolUse': {
      if (!p.tool_name || isHiddenTool(p.tool_name)) return []
      const tool = toolLabel(p.tool_name)
      return [{ kind: 'event', body: { type: 'tool_end', tool, summary: summary(endSummary(p.tool_name, p.tool_input, p.tool_response, p.cwd)) } }]
    }
    case 'UserPromptSubmit': {
      if (typeof p.prompt !== 'string') return []
      const wrapped = CHANNEL_WRAPPER.exec(p.prompt)
      const text = wrapped ? (wrapped[1] ?? '') : p.prompt
      return [{ kind: 'event', body: { type: 'prompt', summary: summary(text), origin: wrapped ? 'glasses' : 'local' } }]
    }
    case 'Notification':
      // idle_prompt ("Claude is waiting for your input") follows every turn by
      // about a minute: noise on a small display, and it only updates state.
      if (p.notification_type === 'idle_prompt') return []
      return typeof p.message === 'string' ? [{ kind: 'event', body: { type: 'notify', summary: summary(p.message) } }] : []
    case 'Stop': {
      const text = p.last_assistant_message
      return typeof text === 'string' && text.trim() ? [{ kind: 'reply', body: { text: clip(redact(text), TEXT_MAX) } }] : []
    }
    default:
      return []
  }
}

/** Derives the session header state from the hook stream. */
export class SessionTracker {
  private current: SessionBody

  constructor(info: { name: string; cwd: string }) {
    this.current = { name: info.name, cwd: info.cwd, state: 'idle' }
  }

  snapshot(): SessionBody {
    return this.current
  }

  /** Returns the new session body if anything changed, else null. */
  update(p: HookPayload): SessionBody | null {
    const state = nextState(this.current.state, p)
    const mode = p.permission_mode ?? this.current.mode
    if (state === this.current.state && mode === this.current.mode) return null
    this.current = { ...this.current, state, ...(mode ? { mode } : {}) }
    return this.current
  }

  /** Used by stop handling (Phase 4): the Stop hook does not fire after a halt. */
  set(state: SessionBody['state']): SessionBody | null {
    if (state === this.current.state) return null
    this.current = { ...this.current, state }
    return this.current
  }
}

function nextState(prev: SessionBody['state'], p: HookPayload): SessionBody['state'] {
  switch (p.hook_event_name) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working'
    case 'Notification':
      if (p.notification_type === 'permission_prompt') return 'waiting'
      if (p.notification_type === 'idle_prompt') return 'idle'
      return prev
    case 'Stop':
      return 'idle'
    default:
      return prev
  }
}
