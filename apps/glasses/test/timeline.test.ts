import { describe, expect, test } from 'bun:test'
import { getTextWidth } from '@evenrealities/pretext'
import { TIMELINE_WIDTH } from '../src/layout'
import { buildTimeline, visibleWindow, type TimelineEntry } from '../src/timeline'

const e = (over: Partial<TimelineEntry> & Pick<TimelineEntry, 'kind' | 'text'>, id = Math.random().toString()): TimelineEntry => ({ id, ts: 0, ...over })

describe('buildTimeline', () => {
  test('formats each kind', () => {
    const { lines } = buildTimeline([
      e({ kind: 'prompt', text: 'list the files', origin: 'glasses' }),
      e({ kind: 'tool', tool: 'Bash', text: 'ls -la', result: 'ok' }),
      e({ kind: 'tool', tool: 'Edit', text: 'src/a.ts' }),
      e({ kind: 'notify', text: 'Claude needs your permission' }),
      e({ kind: 'glance', text: 'Listed files' }),
    ])
    expect(lines).toEqual(['> list the files (voice)', '• Bash: ls -la → ok', '▶ Edit: src/a.ts', '! Claude needs your permission', '» Listed files'])
  })

  test('replies get breathing room, and each new turn starts after a blank line', () => {
    const { lines, starts } = buildTimeline([
      e({ kind: 'prompt', text: 'one' }, 'p1'),
      e({ kind: 'reply', text: 'Answer one.' }, 'r1'),
      e({ kind: 'prompt', text: 'two' }, 'p2'),
    ])
    expect(lines).toEqual(['> one', '', 'Answer one.', '', '> two'])
    expect(starts.get('r1')).toBe(2)
    expect(starts.get('p2')).toBe(4)
  })

  test('long prompts wrap with an indent; every line fits', () => {
    const { lines } = buildTimeline([e({ kind: 'prompt', text: 'please '.repeat(60) }), e({ kind: 'reply', text: 'word '.repeat(300) })])
    expect(lines[1]!.startsWith('  ')).toBe(true)
    for (const l of lines) expect(getTextWidth(l)).toBeLessThanOrEqual(TIMELINE_WIDTH)
  })

  test('a tool with no summary shows just the tool', () => {
    expect(buildTimeline([e({ kind: 'tool', tool: 'Read', text: 'Read', result: 'done' })]).lines).toEqual(['• Read → done'])
  })
})

describe('visibleWindow', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `L${i}`)
  test('follows the bottom, or a window scrolled up', () => {
    expect(visibleWindow(lines, 3, 0)).toEqual(['L17', 'L18', 'L19'])
    expect(visibleWindow(lines, 3, 5)).toEqual(['L12', 'L13', 'L14'])
    expect(visibleWindow(['a'], 3, 0)).toEqual(['a'])
  })

  test('a long glance or note wraps instead of being cut, continuation lines indented', () => {
    const text = 'All 34 references verified and pushed (acf8f17); 5 real errors fixed, 3 TODO-CITEs resolved'
    const { lines } = buildTimeline([e({ kind: 'glance', text }), e({ kind: 'notify', text })])
    const glance = lines.slice(0, lines.indexOf(lines.find(l => l.startsWith('! '))!))
    expect(glance.length).toBeGreaterThan(1)
    expect(glance[0]!.startsWith('» ')).toBe(true)
    expect(glance.slice(1).every(l => l.startsWith('  '))).toBe(true)
    expect(glance.join(' ').replace(/^» /, '').replace(/\s+/g, ' ')).toBe(text)
    expect(lines.every(l => getTextWidth(l) <= TIMELINE_WIDTH)).toBe(true)
    expect(lines.some(l => l.includes('...'))).toBe(false)
  })

  test('reply bullets, numbered items and indented code keep a hanging indent', () => {
    const long = 'this item is long enough that it has to wrap onto a second line on the glasses'
    const { lines } = buildTimeline([e({ kind: 'reply', text: `• ${long}\n12. ${long}\n    const x = ${long}` })])
    const at = (prefix: string) => lines.findIndex(l => l.startsWith(prefix))
    const b = at('• '), n = at('12. '), c = at('    const')
    expect(lines[b + 1]!.startsWith('  ')).toBe(true)
    expect(lines[n + 1]!.startsWith('    ')).toBe(true)
    expect(lines[c + 1]!.startsWith('    ')).toBe(true)
    expect(lines.every(l => getTextWidth(l) <= TIMELINE_WIDTH)).toBe(true)
  })
})
