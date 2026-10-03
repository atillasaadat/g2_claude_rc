// Masks secrets before anything leaves the computer. Hook payloads, unlike
// permission previews, are not redacted by Claude Code, so a Bash command or
// a final reply can carry a token. This runs on every outbound string.
//
// Best effort: it catches well-known token shapes and secret-named
// assignments. Unprefixed random secrets can still slip through, which is
// why the glasses also truncate aggressively.

const R = '[REDACTED]'

const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic
  /\bgsk_[A-Za-z0-9]{20,}/g, // Groq
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
]

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
// "Bearer" is rare in prose. Basic and Token only count inside an Authorization header,
// since "basic usage" and "token parsing" are ordinary English.
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi
const AUTH_HEADER = /(\bAuthorization\s*:\s*)(?:(Basic|Bearer|Token)\s+)?([^\s"']{4,})/gi
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi

// NAME=value, NAME: value, --name value, --name=value, with optional quotes.
const SECRET_NAME = String.raw`[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth)[A-Za-z0-9_-]*`
const ASSIGNMENT = new RegExp(String.raw`(\b${SECRET_NAME}\s*[=:]\s*|--${SECRET_NAME}[=\s]+)(["']?)([^\s"']+)\2`, 'gi')

export function redact(text: string): string {
  let out = text.replace(PRIVATE_KEY, '[REDACTED PRIVATE KEY]')
  for (const re of TOKEN_PATTERNS) out = out.replace(re, R)
  out = out.replace(BEARER, (_m, scheme: string) => `${scheme} ${R}`)
  out = out.replace(AUTH_HEADER, (m, prefix: string, scheme: string | undefined, value: string) =>
    value === R ? m : `${prefix}${scheme ? `${scheme} ` : ''}${R}`,
  )
  out = out.replace(URL_CREDENTIALS, `$1${R}@`)
  out = out.replace(ASSIGNMENT, (m, prefix: string, quote: string, value: string) =>
    value === R || /^authorization/i.test(prefix) ? m : `${prefix}${quote}${R}${quote}`,
  )
  return out
}

/** Single line, no control characters. */
export function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
