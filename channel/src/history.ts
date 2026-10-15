// A session's recent feed (events, replies, glances), resent to the glasses
// on every resync. The relay keeps a history too, but one ring serves every
// session on the computer and fills up with resyncs, so a phone that opens
// later often finds nothing of a session but its header.
//
// Kept in ~/.g2cc/sessions/<sid>.history.json (0600), so a restarted channel
// (/reload-plugins, a plugin update, claude --resume) still has it. The text
// is already redacted and clipped, as on the wire. Files untouched for
// HISTORY_FILE_TTL_MS are deleted when a channel starts.

import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HISTORY_BYTES_MAX, HISTORY_ITEMS_MAX, HISTORY_REPLY_MAX, historyItemSchema, type HistoryItem } from '@g2cc/protocol'

export const HISTORY_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SUFFIX = '.history.json'

export const historyPath = (sessionsDir: string, sid: string): string => join(sessionsDir, `${sid}${SUFFIX}`)

/** Deletes history files of sessions not seen for a week. Best effort. */
export function pruneHistoryFiles(sessionsDir: string, now = Date.now()): void {
  try {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith(SUFFIX)) continue
      const path = join(sessionsDir, name)
      if (now - statSync(path).mtimeMs > HISTORY_FILE_TTL_MS) rmSync(path, { force: true })
    }
  } catch {
    // A missing or unreadable directory just means nothing to prune.
  }
}

export class SessionHistory {
  private items: HistoryItem[] = []

  /** `path` null keeps the history in memory only. */
  constructor(private readonly path: string | null) {
    if (!path) return
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!Array.isArray(raw)) return
      // A damaged entry is skipped, not trusted: everything here goes back on the wire.
      this.items = raw.flatMap(x => {
        const r = historyItemSchema.safeParse(x)
        return r.success ? [r.data] : []
      })
      this.trim()
    } catch {
      // No file yet, or unreadable: start empty.
    }
  }

  record(item: HistoryItem): void {
    const clipped =
      item.kind === 'reply' && item.body.text.length > HISTORY_REPLY_MAX
        ? { ...item, body: { text: `${item.body.text.slice(0, HISTORY_REPLY_MAX - 1)}…` } }
        : item
    this.items = [...this.items, clipped]
    this.trim()
    if (!this.path) return
    try {
      writeFileSync(this.path, JSON.stringify(this.items), { mode: 0o600 })
    } catch {
      // Best effort: the history in memory still serves this channel.
    }
  }

  /** Oldest first, within HISTORY_ITEMS_MAX and HISTORY_BYTES_MAX. */
  snapshot(): readonly HistoryItem[] {
    return this.items
  }

  private trim(): void {
    let kept = this.items.slice(-HISTORY_ITEMS_MAX)
    let bytes = kept.reduce((n, x) => n + Buffer.byteLength(JSON.stringify(x)) + 1, 0)
    while (bytes > HISTORY_BYTES_MAX && kept.length) {
      bytes -= Buffer.byteLength(JSON.stringify(kept[0])) + 1
      kept = kept.slice(1)
    }
    this.items = kept
  }
}
