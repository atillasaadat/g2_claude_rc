// The channel's single outbound connection to the relay. Reconnects with
// exponential backoff and jitter, and buffers the newest frames while offline.

export type RelayStatus = 'connecting' | 'open' | 'closed'

export interface Presence {
  t: 'presence'
  computer: number
  glasses: number
}

export interface RelayClientOptions {
  /** Full WebSocket URL, including room and role. */
  url: string
  onFrame: (frame: Uint8Array) => void
  onStatus?: (status: RelayStatus) => void
  onPresence?: (presence: Presence) => void
  /** Called when the relay says this socket is over its rate limit. */
  onRateLimited?: () => void
  bufferMax?: number
  minBackoffMs?: number
  maxBackoffMs?: number
  pingIntervalMs?: number
}

export class RelayClient {
  private ws: WebSocket | null = null
  private readonly buffer: Uint8Array[] = []
  private attempt = 0
  private stopped = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private readonly bufferMax: number
  private readonly minBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly pingIntervalMs: number

  constructor(private readonly opts: RelayClientOptions) {
    this.bufferMax = opts.bufferMax ?? 50
    this.minBackoffMs = opts.minBackoffMs ?? 500
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000
    this.pingIntervalMs = opts.pingIntervalMs ?? 25_000
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.clearPing()
    this.ws?.close(1000, 'bye')
    this.ws = null
  }

  send(frame: Uint8Array): void {
    if (this.isOpen) {
      this.ws!.send(frame)
      return
    }
    this.buffer.push(frame)
    if (this.buffer.length > this.bufferMax) this.buffer.splice(0, this.buffer.length - this.bufferMax)
  }

  private connect(): void {
    this.opts.onStatus?.('connecting')
    const ws = new WebSocket(this.opts.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      this.opts.onStatus?.('open')
      for (const frame of this.buffer.splice(0)) ws.send(frame)
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping')
      }, this.pingIntervalMs)
    }

    ws.onmessage = ev => {
      if (typeof ev.data !== 'string') {
        this.opts.onFrame(new Uint8Array(ev.data as ArrayBuffer))
        return
      }
      if (ev.data === 'pong') return
      try {
        const msg = JSON.parse(ev.data) as { t?: unknown }
        if (msg.t === 'presence') this.opts.onPresence?.(msg as Presence)
        else if (msg.t === 'rate_limited') this.opts.onRateLimited?.()
      } catch {
        // Unknown control text: ignore.
      }
    }

    ws.onclose = () => {
      if (this.ws !== ws) return
      this.clearPing()
      this.ws = null
      this.opts.onStatus?.('closed')
      if (!this.stopped) this.scheduleReconnect()
    }
    // onclose always follows onerror, so reconnect is handled there.
    ws.onerror = () => {}
  }

  private scheduleReconnect(): void {
    const ceiling = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** this.attempt)
    this.attempt += 1
    const delay = ceiling / 2 + Math.random() * (ceiling / 2)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.connect()
    }, delay)
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }
}
