// Localhost endpoint for Claude Code's `type: "http"` hooks.
//
// Claude Code treats non-2xx responses and connection errors as non-blocking,
// so every failure here fails open. Browser hardening: requiring
// application/json forces a CORS preflight we never answer, and the Host check
// defeats DNS rebinding, so a web page cannot post fake hook events.

export type HookResponse = Record<string, unknown>

export interface HookServerOptions {
  port: number
  onHook: (payload: Record<string, unknown>) => HookResponse | Promise<HookResponse>
}

export interface HookServer {
  readonly port: number
  readonly hostname: string
  stop(): void
}

const HOSTNAME = '127.0.0.1'
const MAX_BODY_BYTES = 5 * 1024 * 1024

/** Throws if the port is already in use. */
export function startHookServer(opts: HookServerOptions): HookServer {
  let allowedHosts = new Set<string>()
  const server = Bun.serve({
    hostname: HOSTNAME,
    port: opts.port,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/hook' || req.method !== 'POST') return new Response('not found', { status: 404 })
      if (!allowedHosts.has(req.headers.get('host') ?? '')) return new Response('forbidden', { status: 403 })
      if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
        return new Response('expected application/json', { status: 415 })
      }
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
  const port = server.port as number
  allowedHosts = new Set([`${HOSTNAME}:${port}`, `localhost:${port}`])
  return { port, hostname: HOSTNAME, stop: () => server.stop(true) }
}
