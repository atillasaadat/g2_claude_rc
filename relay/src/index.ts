// g2cc relay: forwards opaque encrypted frames between the channel (computer)
// and the glasses app. One Durable Object per room. No accounts, no plaintext.
//
//   GET [/g2-claude]/v1/room/<roomId>?role=computer|glasses   (WebSocket upgrade)
//
// Deployed under https://atillasaadat.com/g2-claude, the same Worker also
// serves the setup guide (/g2-claude/) and the glasses app (/g2-claude/app/)
// as static assets.

export { RelayRoom } from './room'

// Not exported: a Worker's main module may only export handlers and classes.
const PREFIX = '/g2-claude'
const ROOM_PATH = /^(?:\/g2-claude)?\/v1\/room\/([0-9a-f]{32})$/
const ROLES = new Set(['computer', 'glasses'])

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/' || url.pathname === PREFIX) {
      return Response.redirect(new URL(`${PREFIX}/`, url).toString(), 302)
    }

    const match = ROOM_PATH.exec(url.pathname)
    if (!match) return env.ASSETS.fetch(request)
    const role = url.searchParams.get('role') ?? ''
    if (!ROLES.has(role)) return new Response('bad role', { status: 400 })
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local'
    // A plain string at runtime: tests pass --var CONNECT_LIMIT_ENABLED:false.
    if ((env.CONNECT_LIMIT_ENABLED as string) !== 'false') {
      const { success } = await env.CONNECT_LIMIT.limit({ key: ip })
      if (!success) return new Response('too many connections', { status: 429 })
    }
    const roomId = match[1] as string
    return env.ROOMS.getByName(roomId).fetch(request)
  },
} satisfies ExportedHandler<Env>
