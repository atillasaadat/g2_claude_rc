// g2cc relay: forwards opaque encrypted frames between the channel (computer)
// and the glasses app. One Durable Object per room. No accounts, no plaintext.
//
//   GET /v1/room/<roomId>?role=computer|glasses   (WebSocket upgrade)

export { RelayRoom } from './room'

const ROOM_PATH = /^\/v1\/room\/([0-9a-f]{32})$/
const ROLES = new Set(['computer', 'glasses'])

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/') return new Response('g2cc relay\n')

    const match = ROOM_PATH.exec(url.pathname)
    if (!match) return new Response('not found', { status: 404 })
    const role = url.searchParams.get('role') ?? ''
    if (!ROLES.has(role)) return new Response('bad role', { status: 400 })
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const roomId = match[1] as string
    return env.ROOMS.getByName(roomId).fetch(request)
  },
} satisfies ExportedHandler<Env>
