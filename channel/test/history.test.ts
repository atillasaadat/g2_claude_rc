// A session's recent feed, kept for the glasses' resync.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HISTORY_BYTES_MAX, HISTORY_ITEMS_MAX, HISTORY_REPLY_MAX, type HistoryItem } from '@g2cc/protocol'
import { SessionController, type Emitted } from '../src/controller'
import { HISTORY_FILE_TTL_MS, historyPath, pruneHistoryFiles, SessionHistory } from '../src/history'

const note = (i: number, ts = i): HistoryItem => ({ id: `n${i}`, ts, kind: 'event', body: { type: 'notify', summary: `note ${i}` } })
const dir = () => mkdtempSync(join(tmpdir(), 'g2-history-'))

describe('SessionHistory', () => {
  test('keeps the newest items, oldest first', () => {
    const h = new SessionHistory(null)
    for (let i = 0; i < HISTORY_ITEMS_MAX + 5; i++) h.record(note(i))
    const items = h.snapshot()
    expect(items.length).toBe(HISTORY_ITEMS_MAX)
    expect(items[0]!.id).toBe('n5')
    expect(items.at(-1)!.id).toBe(`n${HISTORY_ITEMS_MAX + 4}`)
  })

  test('stays within the byte budget, and clips long replies', () => {
    const h = new SessionHistory(null)
    for (let i = 0; i < 20; i++) h.record({ id: `r${i}`, ts: i, kind: 'reply', body: { text: 'x'.repeat(10_000) } })
    const items = h.snapshot()
    expect(JSON.stringify(items).length).toBeLessThanOrEqual(HISTORY_BYTES_MAX + items.length)
    expect(items.at(-1)!.id).toBe('r19')
    const last = items.at(-1)!
    expect(last.kind === 'reply' && last.body.text.length).toBe(HISTORY_REPLY_MAX)
  })

  test('the budget counts bytes, so non-ASCII text cannot overflow a frame', () => {
    const h = new SessionHistory(null)
    for (let i = 0; i < 40; i++) h.record({ id: `r${i}`, ts: i, kind: 'reply', body: { text: '日本語'.repeat(1_300) } })
    expect(Buffer.byteLength(JSON.stringify(h.snapshot()))).toBeLessThanOrEqual(HISTORY_BYTES_MAX + h.snapshot().length)
  })

  test('survives a channel restart through its private file, skipping damaged entries', () => {
    const d = dir()
    const path = historyPath(d, 'sess-1')
    new SessionHistory(path).record(note(1))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify([...raw, { id: 'bad', ts: 1, kind: 'permission', body: {} }, 'junk']))
    expect(new SessionHistory(path).snapshot().map(x => x.id)).toEqual(['n1'])
    writeFileSync(path, '{nope')
    expect(new SessionHistory(path).snapshot()).toEqual([])
  })

  test('history files untouched for a week are deleted', () => {
    const d = dir()
    const old = historyPath(d, 'old')
    const fresh = historyPath(d, 'fresh')
    writeFileSync(old, '[]')
    writeFileSync(fresh, '[]')
    writeFileSync(join(d, 'old.last'), '0')
    const past = (Date.now() - HISTORY_FILE_TTL_MS - 60_000) / 1000
    utimesSync(old, past, past)
    utimesSync(join(d, 'old.last'), past, past)
    pruneHistoryFiles(d)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(join(d, 'old.last'))).toBe(true)
  })
})

describe('resync', () => {
  test('sends the history after the session header, only when there is some', () => {
    const out: Emitted[] = []
    let items: HistoryItem[] = []
    const c = new SessionController({ sessionId: 's', name: 'repo', cwd: '/r', emit: e => out.push(e), history: () => items })
    c.resync()
    expect(out.map(e => e.kind)).toEqual(['session', 'ack'])
    items = [note(1)]
    out.length = 0
    c.resync()
    expect(out.map(e => e.kind)).toEqual(['session', 'ack', 'history'])
    expect(out[2]!.body).toEqual({ items })
  })
})
