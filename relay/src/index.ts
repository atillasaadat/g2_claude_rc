// g2cc relay: forwards opaque encrypted frames between the channel (computer)
// and the glasses app. One Durable Object per room. No accounts, no plaintext.
//
//   GET [/g2-claude]/v1/room/<roomId>?role=computer|glasses&auth=<token>   (WebSocket upgrade)
//   GET [/g2-claude]/v1/pair/<roomId>?role=computer|glasses                 (pairing by code)
//
// A room only admits sockets that present the room's auth token (an HMAC of
// the room ID under the pairing key, see protocol relayAuthToken). Pairing
// rooms have no key yet, so they are short-lived and never evict anyone.
//
// Deployed under https://atillasaadat.com/g2-claude, the same Worker also
// serves the setup guide (/g2-claude/) and the glasses app (/g2-claude/app/)
// as static assets.

export { RelayRoom } from './room'
import { ipKey } from './ip'

// Not exported: a Worker's main module may only export handlers and classes.
const PREFIX = '/g2-claude'
const ROOM_PATH = /^(?:\/g2-claude)?\/v1\/(room|pair)\/([0-9a-f]{32})$/
const ROLES = new Set(['computer', 'glasses'])
const AUTH = /^[A-Za-z0-9_-]{43}$/


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/' || url.pathname === PREFIX) {
      return Response.redirect(new URL(`${PREFIX}/`, url).toString(), 302)
    }

    const match = ROOM_PATH.exec(url.pathname)
    if (!match) return env.ASSETS.fetch(request)
    // Limit first, so malformed requests cost an attacker their budget too.
    // A plain string at runtime: tests pass --var CONNECT_LIMIT_ENABLED:false.
    if ((env.CONNECT_LIMIT_ENABLED as string) !== 'false') {
      const { success } = await env.CONNECT_LIMIT.limit({ key: ipKey(request.headers.get('CF-Connecting-IP') ?? 'local') })
      if (!success) return new Response('too many connections', { status: 429 })
    }
    const role = url.searchParams.get('role') ?? ''
    if (!ROLES.has(role)) return new Response('bad role', { status: 400 })
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const [kind, roomId] = [match[1] as 'room' | 'pair', match[2] as string]
    if (kind === 'room' && !AUTH.test(url.searchParams.get('auth') ?? '')) return new Response('missing auth', { status: 401 })
    return env.ROOMS.getByName(kind === 'pair' ? `pair:${roomId}` : roomId).fetch(request)
  },
} satisfies ExportedHandler<Env>
