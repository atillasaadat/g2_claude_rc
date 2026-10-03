// Hook transport: one private Unix socket per session, no TCP port.
//
// Each channel serves its own session's hooks on ~/.g2cc/sessions/<sid>.sock.
// Claude Code runs `hook.ts` (a `type: "command"` hook) for every hook event;
// it reads session_id from the payload and talks to that session's socket.
// Sessions without a channel have no socket, so their hooks do nothing.
//
// Why not a localhost port: any local process can bind a fixed port first and
// answer hooks with "allow". A socket inside a directory that only this user
// can enter, whose owner the hook checks before connecting, cannot be
// squatted by anyone but this user, who could already edit settings.json.
//
// Every failure fails open: the hook prints nothing and Claude Code carries on.

import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export type HookResponse = Record<string, unknown>

/** Claude Code session ids are UUIDs; anything else never becomes a path. */
export const SAFE_SID = /^[A-Za-z0-9-]{1,64}$/
export const MAX_BODY_BYTES = 5 * 1024 * 1024

const uid = (): number | undefined => process.getuid?.()

/** True if `path` is a real directory (not a symlink) owned by this user and closed to others. */
export function isPrivateDir(path: string): boolean {
  try {
    const st = lstatSync(path)
    const me = uid()
    return st.isDirectory() && !st.isSymbolicLink() && (me === undefined || st.uid === me) && (st.mode & 0o077) === 0
  } catch {
    return false
  }
}

/** Creates (or tightens) ~/.g2cc and its sessions directory, refusing anything it does not own. */
export function ensurePrivateDirs(home: string): string {
  const dir = join(home, 'sessions')
  for (const d of [home, dir]) {
    mkdirSync(d, { recursive: true, mode: 0o700 })
    const st = lstatSync(d)
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${d} is not a directory`)
    if (uid() !== undefined && st.uid !== uid()) throw new Error(`${d} belongs to another user`)
    chmodSync(d, 0o700)
  }
  return dir
}

export function socketPath(home: string, sid: string): string {
  if (!SAFE_SID.test(sid)) throw new Error('unsafe session id')
  return join(home, 'sessions', `${sid}.sock`)
}

export interface HookSocket {
  readonly path: string
  stop(): void
}

export function startHookSocket(opts: {
  home: string
  sid: string
  onHook: (payload: Record<string, unknown>) => HookResponse | Promise<HookResponse>
}): HookSocket {
  ensurePrivateDirs(opts.home)
  const path = socketPath(opts.home, opts.sid)
  // A socket left by a crashed channel of this same session.
  rmSync(path, { force: true })
  const server = Bun.serve({
    unix: path,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(req) {
      if (new URL(req.url).pathname !== '/hook' || req.method !== 'POST') return new Response('not found', { status: 404 })
      let payload: unknown
      try {
        payload = await req.json()
      } catch {
        return new Response('bad json', { status: 400 })
      }
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return new Response('expected an object', { status: 400 })
      }
      try {
        return Response.json(await opts.onHook(payload as Record<string, unknown>))
      } catch {
        return new Response('handler error', { status: 500 })
      }
    },
  })
  chmodSync(path, 0o600)
  const ino = lstatSync(path).ino
  return {
    path,
    stop: () => {
      // Bun unlinks the path when a Unix server stops. If a newer channel of
      // this session has bound it since, leave it alone: this process is
      // exiting anyway, and stopping would remove the newer socket.
      let ours = false
      try {
        ours = lstatSync(path).ino === ino
      } catch {
        // Already gone.
      }
      if (!ours) return
      server.stop(true)
      rmSync(path, { force: true })
    },
  }
}

/**
 * The hook side: forwards one hook payload (Claude Code's stdin) to its
 * session's socket and returns what to print on stdout. Returns '' on any
 * failure, which Claude Code treats as "no decision".
 */
export async function forwardHook(input: string, home: string, timeoutMs = 1_500): Promise<string> {
  try {
    if (input.length > MAX_BODY_BYTES) return ''
    const sid = (JSON.parse(input) as { session_id?: unknown }).session_id
    if (typeof sid !== 'string' || !SAFE_SID.test(sid)) return ''
    if (!isPrivateDir(home) || !isPrivateDir(join(home, 'sessions'))) return ''
    const path = socketPath(home, sid)
    const st = lstatSync(path)
    if (!st.isSocket() || (uid() !== undefined && st.uid !== uid())) return ''
    const res = await fetch('http://g2/hook', {
      unix: path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: input,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return ''
    const text = (await res.text()).trim()
    return text.startsWith('{') && text.endsWith('}') && text !== '{}' ? text : ''
  } catch {
    return ''
  }
}
