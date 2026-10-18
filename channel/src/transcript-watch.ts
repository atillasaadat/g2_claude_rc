// Reads what Claude Code appends to the session transcript, for two things no
// hook reports (checked in a live session, docs/decisions.md):
//   - a permission dialog answered No in the terminal or the web view: the
//     tool never runs, so there is no PostToolUse, PostToolUseFailure or Stop,
//     only a tool_result for its tool_use_id;
//   - a turn interrupted there (Esc, or that No): a "[Request interrupted by
//     user" message, and again no Stop.
// It polls only while active (a turn running or a card open), and reads only
// the bytes added since, never the whole file. The path comes from hook
// payloads on our own socket; it is only ever read.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export interface TranscriptNews {
  /** tool_use_ids that got a result. */
  toolResults: string[]
  /** The turn was interrupted by the user. */
  interrupted: boolean
}

const INTERRUPT = '[Request interrupted by user'
/** At most this much is read per poll; a burst larger than that skips ahead. */
const MAX_READ = 1 << 20

export class TranscriptWatch {
  private path: string | null = null
  private offset = 0
  private rest = ''
  private active = false
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly onNews: (news: TranscriptNews) => void,
    private readonly opts: { everyMs?: number } = {},
  ) {}

  setPath(path: unknown): void {
    if (typeof path !== 'string' || !isAbsolute(path) || !path.endsWith('.jsonl') || path === this.path) return
    this.path = path
    this.skipToEnd()
  }

  /** Active: poll for news. Becoming active skips everything already written. */
  setActive(on: boolean): void {
    if (on === this.active) return
    this.active = on
    if (on) this.skipToEnd()
    const every = this.opts.everyMs ?? 1_000
    if (on && every > 0) this.timer = setInterval(() => this.poll(), every)
    if (!on && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  stop(): void {
    this.setActive(false)
  }

  poll(): void {
    if (!this.active || !this.path) return
    let size: number
    try {
      size = statSync(this.path).size
    } catch {
      return
    }
    if (size < this.offset) this.skipToEnd() // rewritten: start over from its end
    if (size <= this.offset) return
    const from = Math.max(this.offset, size - MAX_READ)
    if (from > this.offset) this.rest = ''
    const buf = Buffer.alloc(size - from)
    let fd: number | null = null
    try {
      fd = openSync(this.path, 'r')
      readSync(fd, buf, 0, buf.length, from)
    } catch {
      return
    } finally {
      if (fd !== null) closeSync(fd)
    }
    this.offset = size
    const text = this.rest + buf.toString('utf8')
    const lines = text.split('\n')
    this.rest = lines.pop() ?? ''
    const news: TranscriptNews = { toolResults: [], interrupted: false }
    for (const l of lines) read(l, news)
    if (news.toolResults.length || news.interrupted) this.onNews(news)
  }

  private skipToEnd(): void {
    this.rest = ''
    try {
      this.offset = this.path ? statSync(this.path).size : 0
    } catch {
      this.offset = 0
    }
  }
}

function read(line: string, news: TranscriptNews): void {
  if (!line.includes('"tool_result"') && !line.includes(INTERRUPT)) return
  let entry: { type?: unknown; message?: { content?: unknown } }
  try {
    entry = JSON.parse(line) as typeof entry
  } catch {
    return
  }
  const content = entry.type === 'user' ? entry.message?.content : undefined
  // A plain string is something the user typed, never a marker.
  if (!Array.isArray(content)) return
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') news.toolResults.push(block.tool_use_id)
    if (block.type === 'text' && typeof block.text === 'string' && block.text.startsWith(INTERRUPT)) news.interrupted = true
  }
}
