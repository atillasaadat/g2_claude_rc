// Multi-session hook routing without a daemon.
//
// Hook URLs in settings.json name one fixed port (27183), but every Claude
// Code session spawns its own channel. So each channel serves its own session
// on a private random port and registers it in ~/.g2cc/sessions/<sid>.json.
// Whichever channel holds 27183 is the router: it answers its own session's
// hooks locally and forwards the rest by session_id. When the router's
// session ends, another channel takes the port over. Everything fails open.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HookResponse } from './hook-server'

export interface SessionEntry {
  sid: string
  port: number
  pid: number
}

// Claude Code session ids are UUIDs; anything else never becomes a path.
const SAFE_SID = /^[A-Za-z0-9-]{1,64}$/

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class SessionRegistry {
  readonly dir: string

  constructor(home: string) {
    this.dir = join(home, 'sessions')
  }

  private path(sid: string): string {
    if (!SAFE_SID.test(sid)) throw new Error('unsafe session id')
    return join(this.dir, `${sid}.json`)
  }

  register(sid: string, port: number, pid: number = process.pid): void {
    const path = this.path(sid)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    chmodSync(this.dir, 0o700)
    writeFileSync(`${path}.tmp`, JSON.stringify({ sid, port, pid }), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }

  unregister(sid: string): void {
    if (SAFE_SID.test(sid)) rmSync(this.path(sid), { force: true })
  }

  lookup(sid: string): SessionEntry | null {
    if (!SAFE_SID.test(sid)) return null
    const path = this.path(sid)
    if (!existsSync(path)) return null
    try {
      const e = JSON.parse(readFileSync(path, 'utf8')) as SessionEntry
      return Number.isInteger(e.port) && Number.isInteger(e.pid) && alive(e.pid) ? e : null
    } catch {
      return null
    }
  }
}

export interface RouteOptions {
  ownSid: string | undefined
  local: (payload: Record<string, unknown>) => HookResponse
  registry: SessionRegistry
  timeoutMs?: number
}

/** Router side: answer locally, or forward to the session that owns the hook. */
export async function routeHook(payload: Record<string, unknown>, opts: RouteOptions): Promise<HookResponse> {
  const sid = typeof payload.session_id === 'string' ? payload.session_id : undefined
  if (!sid || !opts.ownSid || sid === opts.ownSid) return opts.local(payload)
  const entry = opts.registry.lookup(sid)
  if (!entry) return {}
  try {
    const res = await fetch(`http://127.0.0.1:${entry.port}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1_500),
    })
    return res.ok ? ((await res.json()) as HookResponse) : {}
  } catch {
    return {} // fail open: Claude Code continues as if no hook ran
  }
}
