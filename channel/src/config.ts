import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** Fixed because the hook URLs in settings.json must name it. See docs/decisions.md. */
export const DEFAULT_PORT = 27183
/** The hosted relay. For a local `wrangler dev` relay, set G2CC_RELAY_URL=ws://127.0.0.1:8789. */
export const DEFAULT_RELAY_URL = 'wss://atillasaadat.com/g2-claude'

export interface ChannelConfig {
  home: string
  port: number
  /** Set by Claude Code in the channel's environment; matches hook `session_id`. */
  sessionId: string | undefined
  projectDir: string
  sessionName: string
  relayUrlOverride: string | undefined
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`G2CC_PORT must be a port number, got ${raw}`)
  return n
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ChannelConfig {
  const projectDir = env.CLAUDE_PROJECT_DIR ?? process.cwd()
  return {
    home: env.G2CC_HOME ?? join(homedir(), '.g2cc'),
    port: parsePort(env.G2CC_PORT) ?? DEFAULT_PORT,
    sessionId: env.CLAUDE_CODE_SESSION_ID || undefined,
    projectDir,
    sessionName: basename(projectDir),
    relayUrlOverride: env.G2CC_RELAY_URL || undefined,
  }
}

export function relaySocketUrl(relayUrl: string, roomId: string, role: 'computer' | 'glasses'): string {
  return `${relayUrl.replace(/\/+$/, '')}/v1/room/${roomId}?role=${role}`
}
