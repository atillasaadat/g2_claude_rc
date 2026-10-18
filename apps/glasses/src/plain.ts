// Claude replies are Markdown. The glasses have one font and no styling, so
// markup characters are just noise: reduce them to plain text.

const FENCE = /^\s*(```|~~~)/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const HEADING = /^\s{0,3}#{1,6}\s+/
const QUOTE = /^\s{0,3}(>\s?)+/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const BULLET = /^(\s*)[-*+]\s+/

function inline(line: string): string {
  return (
    line
      .replace(/!\[([^\]]*)\]\([^)\s]+\)/g, '$1') // ![alt](image)
      .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1') // [text](url)
      .replace(/(`+)\s?(.+?)\s?\1/g, '$2') // `code`, or ``code with ` inside``
      .replace(/~~(?=\S)(.+?)~~/g, '$1')
      .replace(/\*\*(?=\S)(.+?)\*\*/g, '$1')
      .replace(/__(?=\S)(.+?)__/g, '$1')
      // *italic*: word-bounded so "2 * 3" survives. _italic_ is left alone, to keep snake_case.
      .replace(/(^|[\s(])\*(?=\S)([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, '$1$2')
      // \* and friends: the character itself.
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
  )
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(c => inline(c.trim()))

/**
 * A table row as one list item the glasses can wrap: "first: second" for two
 * columns, else "first · header: value · ...", so no value loses its column.
 */
function tableRow(row: string[], header: readonly string[]): string {
  const [first = '', ...rest] = row
  if (rest.length === 1) return `• ${first}: ${rest[0]}`
  const labelled = rest.map((v, i) => (header[i + 1] ? `${header[i + 1]}: ${v}` : v)).filter(v => v.trim())
  return ['• ' + first, ...labelled].join(' · ')
}

export function toPlainText(markdown: string): string {
  const out: string[] = []
  let inFence = false
  let header: string[] = []
  const lines = markdown.replace(/\r/g, '').replace(/<br\s*\/?>/gi, '\n').split('\n')
  for (const [i, raw] of lines.entries()) {
    if (FENCE.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(raw)
      continue
    }
    if (TABLE_ROW.test(raw)) {
      // The row above the |---| rule is the header: it labels the values below.
      if (TABLE_RULE.test(lines[i + 1] ?? '')) header = cells(raw)
      else if (!TABLE_RULE.test(raw)) out.push(tableRow(cells(raw), header))
      continue
    }
    header = []
    if (RULE.test(raw)) {
      out.push('')
      continue
    }
    const line = raw.replace(HEADING, '').replace(QUOTE, '').replace(BULLET, '$1• ')
    out.push(inline(line))
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
