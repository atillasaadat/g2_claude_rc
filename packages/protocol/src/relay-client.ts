// The channel's single outbound connection to the relay. Reconnects with
// exponential backoff and jitter, and buffers the newest frames while offline.
// A link can die without closing (a laptop sleeps, the network changes): TCP
// then retries for many minutes while the socket still reads as open. So once
// the relay has answered a ping, silence for DEAD_AFTER_PINGS ping intervals
// counts as a dead link, and the client drops it and reconnects.

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
  /** How long probe() waits for any answer before it drops the link. */
  probeTimeoutMs?: number
}

/** Ping intervals without hearing anything before an answering relay counts as gone. */
const DEAD_AFTER_PINGS = 2.5

export class RelayClient {
  private ws: WebSocket | null = null
  private readonly buffer: Uint8Array[] = []
  private attempt = 0
  private stopped = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private lastHeard = 0
  private readonly bufferMax: number
  private readonly minBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly pingIntervalMs: number
  private readonly probeTimeoutMs: number

  constructor(private readonly opts: RelayClientOptions) {
    this.bufferMax = opts.bufferMax ?? 50
    this.minBackoffMs = opts.minBackoffMs ?? 500
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000
    this.pingIntervalMs = opts.pingIntervalMs ?? 25_000
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 4_000
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
    this.clearProbe()
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

  /**
   * Checks the link now instead of at the next ping: a ping that gets no
   * answer within probeTimeoutMs drops the link and reconnects, which flushes the
   * buffer. For a sender that is waiting on an ack, and when the app returns
   * to the foreground. While closed, it reconnects at once instead of waiting
   * out the backoff.
   */
  probe(): void {
    if (this.stopped || this.probeTimer) return
    const ws = this.ws
    if (!ws) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
        this.connect()
      }
      return
    }
    if (ws.readyState !== WebSocket.OPEN) return
    const asked = Date.now()
    try {
      ws.send('ping')
    } catch {
      this.drop(ws)
      return
    }
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null
      if (this.ws === ws && this.lastHeard < asked) this.drop(ws)
    }, this.probeTimeoutMs)
  }

  private connect(): void {
    this.opts.onStatus?.('connecting')
    const ws = new WebSocket(this.opts.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    this.lastHeard = Date.now()
    // Only a relay that answers pings can be judged by silence (older ones did not).
    let answersPings = false

    ws.onopen = () => {
      this.attempt = 0
      this.lastHeard = Date.now()
      this.opts.onStatus?.('open')
      for (const frame of this.buffer.splice(0)) ws.send(frame)
      this.pingTimer = setInterval(() => {
        if (answersPings && Date.now() - this.lastHeard > this.pingIntervalMs * DEAD_AFTER_PINGS) {
          this.drop(ws)
          return
        }
        if (ws.readyState === WebSocket.OPEN) ws.send('ping')
      }, this.pingIntervalMs)
    }

    ws.onmessage = ev => {
      if (this.ws === ws) this.lastHeard = Date.now()
      if (ev.data === 'pong') answersPings = true
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
      this.clearProbe()
      this.ws = null
      this.opts.onStatus?.('closed')
      if (!this.stopped) this.scheduleReconnect()
    }
    // onclose always follows onerror, so reconnect is handled there.
    ws.onerror = () => {}
  }

  /** Gives up on a dead link at once, without waiting for TCP to notice. */
  private drop(ws: WebSocket): void {
    if (this.ws !== ws) return
    ws.onopen = ws.onmessage = ws.onclose = null
    try {
      ws.close(4000, 'no answer')
    } catch {
      // Already closing.
    }
    this.clearPing()
    this.clearProbe()
    this.ws = null
    this.opts.onStatus?.('closed')
    if (!this.stopped) this.scheduleReconnect()
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

  private clearProbe(): void {
    if (this.probeTimer) clearTimeout(this.probeTimer)
    this.probeTimer = null
  }
}
