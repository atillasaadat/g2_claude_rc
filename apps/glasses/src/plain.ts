// Claude replies are Markdown. The glasses have one font and no styling, so
// markup characters are just noise: reduce them to plain text.

const FENCE = /^\s*(```|~~~)/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const HEADING = /^\s{0,3}#{1,6}\s+/
const QUOTE = /^\s{0,3}>\s?/
const BULLET = /^(\s*)[-*+]\s+/

function inline(line: string): string {
  return (
    line
      .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1') // [text](url)
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*(?=\S)(.+?)\*\*/g, '$1')
      .replace(/__(?=\S)(.+?)__/g, '$1')
      // *italic*: word-bounded so "2 * 3" survives. _italic_ is left alone, to keep snake_case.
      .replace(/(^|[\s(])\*(?=\S)([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, '$1$2')
  )
}

export function toPlainText(markdown: string): string {
  const out: string[] = []
  let inFence = false
  for (const raw of markdown.replace(/\r/g, '').split('\n')) {
    if (FENCE.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(raw)
      continue
    }
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
