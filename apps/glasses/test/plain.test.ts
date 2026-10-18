import { describe, expect, test } from 'bun:test'
import { toPlainText } from '../src/plain'

describe('toPlainText', () => {
  test('strips emphasis, inline code, and links', () => {
    expect(toPlainText('**Done.** Ran `bun test` and see [the docs](https://x.dev).')).toBe('Done. Ran bun test and see the docs.')
    expect(toPlainText('__bold__ and *italic* text')).toBe('bold and italic text')
  })

  test('keeps snake_case and lone asterisks intact', () => {
    expect(toPlainText('set MAX_FRAME_BYTES and 2 * 3')).toBe('set MAX_FRAME_BYTES and 2 * 3')
  })

  test('turns headings into plain lines and rules into blank lines', () => {
    expect(toPlainText('## Summary\nAll good\n\n---\n\nNext')).toBe('Summary\nAll good\n\nNext')
  })

  test('turns list markers into bullets and keeps numbering', () => {
    expect(toPlainText('- one\n* two\n  + nested\n1. first')).toBe('• one\n• two\n  • nested\n1. first')
  })

  test('drops code fences but keeps the code', () => {
    expect(toPlainText('Run:\n```bash\nbun test\n```\nDone')).toBe('Run:\nbun test\nDone')
  })

  test('drops blockquote markers', () => {
    expect(toPlainText('> quoted line')).toBe('quoted line')
  })

  test('collapses runs of blank lines', () => {
    expect(toPlainText('a\n\n\n\nb')).toBe('a\n\nb')
  })

  test('table rows become list items, each value labelled by its column', () => {
    expect(toPlainText('| Test | Result |\n|---|:--:|\n| unit | **pass** |\n| e2e | fail |')).toBe('• unit: pass\n• e2e: fail')
    expect(toPlainText('Results:\n\n| arm | locked | steps |\n|---|---|---|\n| v33 | 37 / 40 | 484 |\n\nDone')).toBe(
      'Results:\n\n• v33 · locked: 37 / 40 · steps: 484\n\nDone',
    )
  })

  test('nested quotes, strikethrough, images, escapes and line breaks', () => {
    expect(toPlainText('>> deep quote\n> > also deep')).toBe('deep quote\nalso deep')
    expect(toPlainText('~~old~~ new ![diagram](x.png) \\*not italic\\*')).toBe('old new diagram *not italic*')
    expect(toPlainText('one<br>two<br/>three')).toBe('one\ntwo\nthree')
    expect(toPlainText('use ``a `b` c`` here')).toBe('use a `b` c here')
  })

  test('task lists keep their boxes', () => {
    expect(toPlainText('- [ ] todo\n- [x] done')).toBe('• [ ] todo\n• [x] done')
  })
})
