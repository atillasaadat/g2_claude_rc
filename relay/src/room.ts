// One relay room. Uses WebSocket hibernation so idle rooms cost nothing.
//
// Frames are binary ciphertext and are never inspected. The relay cannot tell
// a real peer from an impostor that knows the room ID, so nothing here may let
// one socket deprive another of frames:
//   - to glasses: a history ring (last HISTORY_MAX frames, capped by bytes),
//     replayed to every glasses socket on connect. Glasses dedupe by id.
//   - to computer: every command is kept until it expires (PENDING_MAX_AGE_MS)
//     and delivered to every computer socket, live and on connect. The channel's
//     replay guard dedupes, and it rejects commands older than its own start,
//     so redelivery is safe.
//
// Text frames are control messages: "ping" (auto "pong") from clients, and
// presence / rate_limited JSON from the relay. These are metadata only.

import { DurableObject } from 'cloudflare:workers'
import {
  BURST,
  HISTORY_MAX,
  HISTORY_MAX_BYTES,
  MAX_FRAME_BYTES,
  MAX_SOCKETS_PER_ROLE,
  PENDING_MAX,
  PENDING_MAX_AGE_MS,
  PRUNE_EVERY,
  RATE_PER_SEC,
  ROOM_TTL_MS,
} from './limits'

export type Role = 'computer' | 'glasses'

interface Attachment {
  role: Role
  connectedAt: number
}

interface Bucket {
  tokens: number
  last: number
  warnedAt: number
}

const other = (role: Role): Role => (role === 'computer' ? 'glasses' : 'computer')
const isRole = (v: unknown): v is Role => v === 'computer' || v === 'glasses'

/** Close codes a server may send. Anything else becomes 1000. */
function safeCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000
}

export class RelayRoom extends DurableObject<Env> {
  // In memory, so it resets when the object hibernates. Soft limit only.
  private readonly buckets = new WeakMap<WebSocket, Bucket>()
  private insertsSincePrune = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => this.ensureSchema())
    // Keepalive without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS frames (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        to_role TEXT NOT NULL,
        ts INTEGER NOT NULL,
        size INTEGER NOT NULL,
        data BLOB NOT NULL
      )
    `)
  }

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get('role')
    if (!isRole(role)) return new Response('bad role', { status: 400 })

    // A full role evicts its oldest socket rather than refusing the newcomer,
    // so an impostor cannot lock the real peer out by holding every slot.
    const existing = this.sockets(role)
    if (existing.length >= MAX_SOCKETS_PER_ROLE) {
      const oldest = existing.reduce((a, b) => (this.attachment(a).connectedAt <= this.attachment(b).connectedAt ? a : b))
      this.safeClose(oldest, 4000, 'replaced by a newer connection')
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server, [role])
    server.serializeAttachment({ role, connectedAt: Date.now() } satisfies Attachment)
    this.deliverBuffered(server, role)
    this.broadcastPresence()
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === 'string') {
      this.safeClose(ws, 1003, 'binary frames only')
      return
    }
    if (message.byteLength > MAX_FRAME_BYTES) {
      this.safeClose(ws, 1009, 'frame too large')
      return
    }
    if (!this.takeToken(ws)) return

    const from = this.roleOf(ws)
    if (!from) return
    const to = other(from)
    for (const peer of this.sockets(to)) peer.send(message)
    this.store(to, message)
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.safeClose(ws, safeCloseCode(code), 'closing')
    this.broadcastPresence()
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.safeClose(ws, 1011, 'error')
    this.broadcastPresence()
  }

  /** Wipes a room nobody has connected to for ROOM_TTL_MS. */
  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS)
      return
    }
    await this.ctx.storage.deleteAll()
    this.ensureSchema()
  }

  private attachment(ws: WebSocket): Attachment {
    const a = ws.deserializeAttachment() as Partial<Attachment> | null
    return { role: isRole(a?.role) ? a.role : 'glasses', connectedAt: a?.connectedAt ?? 0 }
  }

  private roleOf(ws: WebSocket): Role | null {
    const tag = this.ctx.getTags(ws)[0]
    return isRole(tag) ? tag : null
  }

  private sockets(role: Role): WebSocket[] {
    return this.ctx.getWebSockets(role).filter(ws => ws.readyState === WebSocket.OPEN)
  }

  private safeClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason)
    } catch {
      // Already closing or closed.
    }
  }

  private deliverBuffered(ws: WebSocket, role: Role): void {
    const sql = this.ctx.storage.sql
    if (role === 'computer') {
      sql.exec('DELETE FROM frames WHERE to_role = ? AND ts < ?', 'computer', Date.now() - PENDING_MAX_AGE_MS)
    }
    const limit = role === 'glasses' ? HISTORY_MAX : PENDING_MAX
    const newestFirst = sql
      .exec<{ data: ArrayBuffer; size: number }>(
        'SELECT data, size FROM frames WHERE to_role = ? ORDER BY seq DESC LIMIT ?',
        role,
        limit,
      )
      .toArray()
    // Pruning is amortized, so also enforce the byte cap on the way out.
    const out: ArrayBuffer[] = []
    let bytes = 0
    for (const row of newestFirst) {
      bytes += row.size
      if (bytes > HISTORY_MAX_BYTES) break
      out.push(row.data)
    }
    for (const data of out.reverse()) ws.send(data)
  }

  private store(to: Role, data: ArrayBuffer): void {
    const sql = this.ctx.storage.sql
    sql.exec('INSERT INTO frames (to_role, ts, size, data) VALUES (?, ?, ?, ?)', to, Date.now(), data.byteLength, data)
    if (to === 'computer') {
      // Commands are rare, so prune them eagerly.
      this.prune('computer', PENDING_MAX)
      return
    }
    // History is the hot path. Prune every PRUNE_EVERY inserts to keep
    // free-tier row writes near one per frame.
    this.insertsSincePrune += 1
    if (this.insertsSincePrune >= PRUNE_EVERY) {
      this.insertsSincePrune = 0
      this.prune('glasses', HISTORY_MAX)
    }
  }

  /** Keeps the newest `keep` frames for a role, within HISTORY_MAX_BYTES. */
  private prune(role: Role, keep: number): void {
    const sql = this.ctx.storage.sql
    const rows = sql
      .exec<{ seq: number; size: number }>('SELECT seq, size FROM frames WHERE to_role = ? ORDER BY seq DESC', role)
      .toArray()
    let bytes = 0
    let cutoff: number | null = null
    for (const [i, row] of rows.entries()) {
      bytes += row.size
      if (i >= keep || bytes > HISTORY_MAX_BYTES) {
        cutoff = row.seq
        break
      }
    }
    if (cutoff !== null) sql.exec('DELETE FROM frames WHERE to_role = ? AND seq <= ?', role, cutoff)
  }

  private broadcastPresence(): void {
    const msg = JSON.stringify({
      t: 'presence',
      computer: this.sockets('computer').length,
      glasses: this.sockets('glasses').length,
    })
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg)
    }
  }

  /** Token bucket per socket, so one noisy peer cannot starve the others. */
  private takeToken(ws: WebSocket): boolean {
    const now = Date.now()
    const b = this.buckets.get(ws) ?? { tokens: BURST, last: now, warnedAt: 0 }
    const tokens = Math.min(BURST, b.tokens + ((now - b.last) / 1000) * RATE_PER_SEC)
    if (tokens < 1) {
      const warn = now - b.warnedAt > 1000
      if (warn) ws.send(JSON.stringify({ t: 'rate_limited' }))
      this.buckets.set(ws, { tokens, last: now, warnedAt: warn ? now : b.warnedAt })
      return false
    }
    this.buckets.set(ws, { tokens: tokens - 1, last: now, warnedAt: b.warnedAt })
    return true
  }
}
