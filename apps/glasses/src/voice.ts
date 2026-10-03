// Turns a transcript into a local command or a prompt. Keywords are handled
// on the glasses and never sent to Claude. Matching is strict: the whole
// utterance must be the keyword (plus filler like "please" or "it"), so a
// sentence such as "stop the dev server" stays a prompt.

export type VoiceCommand =
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'approve' }
  | { type: 'deny' }
  | { type: 'empty' }
  | { type: 'prompt'; text: string }

const KEYWORDS: Record<string, VoiceCommand['type']> = {
  stop: 'stop',
  cancel: 'cancel',
  approve: 'approve',
  allow: 'approve',
  deny: 'deny',
  reject: 'deny',
}

const LEADING_FILLER = new Set(['please', 'ok', 'okay', 'yes', 'hey', 'and'])
const TRAILING_FILLER = new Set(['it', 'that', 'claude', 'now', 'please', 'this'])

/** Whisper's usual output for silence or noise. */
const HALLUCINATIONS = new Set(['', 'you', 'thank you', 'thanks', 'thank you for watching', 'thanks for watching', 'bye'])

export function parseVoice(transcript: string): VoiceCommand {
  const normalized = transcript
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (HALLUCINATIONS.has(normalized)) return { type: 'empty' }

  const words = normalized.split(' ')
  while (words.length > 1 && LEADING_FILLER.has(words[0]!)) words.shift()
  while (words.length > 1 && TRAILING_FILLER.has(words[words.length - 1]!)) words.pop()
  const keyword = words.length === 1 ? KEYWORDS[words[0]!] : undefined
  if (keyword) return { type: keyword } as VoiceCommand

  return { type: 'prompt', text: transcript.trim() }
}

const ORDINALS: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3 }
const NUMBERS: Record<string, number> = { one: 0, two: 1, three: 2, four: 3, '1': 0, '2': 1, '3': 2, '4': 3 }
const normalize = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Maps a spoken answer to a question option: the option's text, or its
 * position ("the second one", "option 3"). Returns null unless exactly one
 * option matches, so an ambiguous answer never picks for the user.
 */
export function matchOption(transcript: string, options: readonly string[]): number | null {
  const said = normalize(transcript)
  if (!said) return null
  const opts = options.map(normalize)
  const exact = opts.indexOf(said)
  if (exact >= 0) return exact

  // Positions only count in short answers ("the first one", "option 3"), so a
  // sentence like "run the tests first" is never read as a choice.
  const words = said.split(' ')
  const short = words.length <= 4
  const ordinal = short ? words.map(w => ORDINALS[w]).find(i => i !== undefined) : undefined
  const number = short ? words.map(w => NUMBERS[w]).find(i => i !== undefined) : undefined
  const position = ordinal ?? number
  if (position !== undefined) return position < options.length ? position : null

  const hits = new Set<number>()
  opts.forEach((o, i) => {
    if ((said.length >= 3 && o.includes(said)) || (o.length >= 3 && said.includes(o))) hits.add(i)
  })
  return hits.size === 1 ? [...hits][0]! : null
}
