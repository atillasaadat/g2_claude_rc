// The transcript watch reads only what Claude Code appends while it is active.
import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptWatch, type TranscriptNews } from '../src/transcript-watch'

const line = (o: unknown) => JSON.stringify(o) + '\n'
const result = (id: string, text = 'ok') => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })
const interrupted = line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), 'g2-tw-')), 's.jsonl')
  writeFileSync(path, result('old') + interrupted)
  const news: TranscriptNews[] = []
  const w = new TranscriptWatch(n => news.push(n), { everyMs: 0 })
  return { path, news, w }
}

describe('TranscriptWatch', () => {
  test('reports tool results and interrupts appended after it became active, not older ones', () => {
    const { path, news, w } = setup()
    w.setPath(path)
    w.setActive(true)
    w.poll()
    expect(news).toEqual([])
    appendFileSync(path, result('toolu_1', 'The user doesn\'t want to proceed') + interrupted)
    w.poll()
    expect(news).toEqual([{ toolResults: ['toolu_1'], interrupted: true }])
  })

  test('a line written in two parts is read once it is whole', () => {
    const { path, news, w } = setup()
    w.setPath(path)
    w.setActive(true)
    const r = result('toolu_2')
    appendFileSync(path, r.slice(0, 20))
    w.poll()
    appendFileSync(path, r.slice(20))
    w.poll()
    expect(news).toEqual([{ toolResults: ['toolu_2'], interrupted: false }])
  })

  test('inactive, or without a usable path, it reads nothing', () => {
    const { path, news, w } = setup()
    w.setPath('relative/path.jsonl')
    w.setActive(true)
    appendFileSync(path, result('toolu_3'))
    w.poll()
    w.setPath(path)
    w.setActive(false)
    appendFileSync(path, result('toolu_4'))
    w.poll()
    expect(news).toEqual([])
  })

  test('the user typing the marker text is not an interrupt', () => {
    const { path, news, w } = setup()
    w.setPath(path)
    w.setActive(true)
    appendFileSync(path, line({ type: 'user', message: { role: 'user', content: 'what does [Request interrupted by user] mean?' } }))
    w.poll()
    expect(news).toEqual([])
  })
})
