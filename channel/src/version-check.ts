// SessionStart: tells the user when a newer g2 plugin is out. Claude Code
// leaves auto-update off for marketplaces it does not run, so without this an
// old plugin keeps running silently.
//
// One small GET of the released plugin.json on GitHub (version numbers only
// change through scripts/release.sh, so main always holds the latest release),
// at most every CHECK_EVERY_MS, with the answer cached in ~/.g2cc. Any failure
// says nothing. G2CC_NO_UPDATE_CHECK=1 turns it off.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LATEST_URL = 'https://raw.githubusercontent.com/atillasaadat/g2_claude_rc/main/plugin/.claude-plugin/plugin.json'
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 2_000
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
const CACHE_FILE = 'latest-version.json'

/** True if `a` is a later x.y.z than `b`. Anything that is not x.y.z is never newer. */
export function isNewer(a: string, b: string): boolean {
  if (!VERSION.test(a) || !VERSION.test(b)) return false
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! > pb[i]!
  return false
}

interface Options {
  installed: string
  /** ~/.g2cc */
  home: string
  now: number
  fetch: (url: string, init: RequestInit) => Promise<Response>
  disabled?: boolean
}

function readCache(home: string): { checkedAt: number; latest: string } | null {
  try {
    const c = JSON.parse(readFileSync(join(home, CACHE_FILE), 'utf8')) as { checkedAt?: unknown; latest?: unknown }
    return typeof c.checkedAt === 'number' && typeof c.latest === 'string' && VERSION.test(c.latest) ? { checkedAt: c.checkedAt, latest: c.latest } : null
  } catch {
    return null
  }
}

async function latestVersion(o: Options): Promise<string | null> {
  const cached = readCache(o.home)
  if (cached && o.now - cached.checkedAt < CHECK_EVERY_MS) return cached.latest
  try {
    const res = await o.fetch(LATEST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    const latest = ((await res.json()) as { version?: unknown }).version
    if (typeof latest !== 'string' || !VERSION.test(latest)) return null
    try {
      mkdirSync(o.home, { recursive: true, mode: 0o700 })
      writeFileSync(join(o.home, CACHE_FILE), JSON.stringify({ checkedAt: o.now, latest }), { mode: 0o600 })
    } catch {
      // Not cached: the next session asks again.
    }
    return latest
  } catch {
    return null
  }
}

/** The line to show, or '' when there is nothing to say. */
export async function updateNotice(o: Options): Promise<string> {
  if (o.disabled) return ''
  const latest = await latestVersion(o)
  if (!latest || !isNewer(latest, o.installed)) return ''
  return (
    `g2 plugin ${latest} is out (this session runs ${o.installed}). ` +
    'Run /plugin marketplace update g2cc, then /reload-plugins. ' +
    'To get updates on their own: /plugin, Marketplaces, g2cc, turn on auto-update.'
  )
}
