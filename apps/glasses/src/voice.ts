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
