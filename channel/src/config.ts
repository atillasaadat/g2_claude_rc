import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** The hosted relay. For a local `wrangler dev` relay, set G2CC_RELAY_URL=ws://127.0.0.1:8789. */
export const DEFAULT_RELAY_URL = 'wss://atillasaadat.com/g2-claude'

export interface ChannelConfig {
  home: string
  /** Set by Claude Code in the channel's environment; matches hook `session_id`. */
  sessionId: string | undefined
  projectDir: string
  sessionName: string
  relayUrlOverride: string | undefined
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ChannelConfig {
  const projectDir = env.CLAUDE_PROJECT_DIR ?? process.cwd()
  return {
    home: env.G2CC_HOME ?? join(homedir(), '.g2cc'),
    sessionId: env.CLAUDE_CODE_SESSION_ID || undefined,
    projectDir,
    sessionName: basename(projectDir),
    relayUrlOverride: env.G2CC_RELAY_URL || undefined,
  }
}

