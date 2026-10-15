// Moves a running session to a newer g2 plugin without /reload-plugins.
//
// Only under the launcher (G2CC_LAUNCHER=1, see launcher.ts). Every few
// minutes the channel looks for a newer g2 version beside its own in Claude
// Code's plugin cache. If the released version (version-check.ts, at most one
// GitHub request every 6 hours) is newer than anything installed, it runs
// Claude Code's own installer, `claude plugin update g2@g2cc`, once per
// computer at a time. When a newer version is installed and the session is
// idle (no turn running, no card, question or pairing open), it asks the
// launcher to swap. Nothing is downloaded here: the code comes from the
// marketplace the user added, through Claude Code. G2CC_NO_AUTO_UPDATE=1
// turns it off.

import { closeSync, openSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pluginVersion, validSwapTarget } from './launcher'
import { isNewer, latestVersion } from './version-check'

export const UPDATE_CHECK_EVERY_MS = 10 * 60 * 1000
const FIRST_CHECK_AFTER_MS = 60 * 1000
const LOCK_FILE = 'update.lock'
/** A lock older than this is from an installer that died. */
const LOCK_STALE_MS = 10 * 60 * 1000
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

export interface SelfUpdateOptions {
  /** This channel's plugin root (CLAUDE_PLUGIN_ROOT). */
  root: string
  /** ~/.g2cc */
  home: string
  busy: () => boolean
  requestSwap: (root: string) => void
  /** Runs Claude Code's plugin installer. Resolves when it is done, whatever the outcome. */
  install: () => Promise<void>
  fetch: (url: string, init: RequestInit) => Promise<Response>
  now: () => number
  log: (msg: string) => void
}

/** The newest g2 version installed beside `root` that is newer than it, or null. */
export function newestInstalled(root: string): string | null {
  let best: { dir: string; version: string } | null = null
  try {
    for (const name of readdirSync(dirname(root))) {
      const dir = join(dirname(root), name)
      if (!validSwapTarget(root, dir)) continue
      const version = pluginVersion(dir)!
      if (!best || isNewer(version, best.version)) best = { dir, version }
    }
  } catch {
    return null
  }
  return best?.dir ?? null
}

/** Takes the per-computer installer lock; false if another channel holds it. */
export function takeLock(home: string, now: number): (() => void) | null {
  const path = join(home, LOCK_FILE)
  try {
    if (now - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { force: true })
  } catch {
    // No lock yet.
  }
  try {
    closeSync(openSync(path, 'wx', 0o600))
    return () => rmSync(path, { force: true })
  } catch {
    return null
  }
}

export class SelfUpdate {
  /** The release this channel already ran the installer for. */
  private triedFor = ''
  private running = false

  constructor(private readonly o: SelfUpdateOptions) {}

  async check(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.checkInner()
    } finally {
      this.running = false
    }
  }

  private async checkInner(): Promise<void> {
    const installed = pluginVersion(this.o.root)
    if (!installed) return
    if (this.swapIfReady()) return
    const latest = await latestVersion({ home: this.o.home, now: this.o.now(), fetch: this.o.fetch })
    if (!latest || !isNewer(latest, installed) || this.triedFor === latest) return
    const release = takeLock(this.o.home, this.o.now())
    if (!release) return
    this.triedFor = latest
    try {
      this.o.log(`installing g2 ${latest} with claude plugin update`)
      await this.o.install()
    } finally {
      release()
    }
    this.swapIfReady()
  }

  private swapIfReady(): boolean {
    const target = newestInstalled(this.o.root)
    if (!target) return false
    if (!this.o.busy()) this.o.requestSwap(target)
    return true
  }
}

/** Runs `claude plugin update g2@g2cc`, quietly, with a time limit. */
export async function runClaudeInstaller(): Promise<void> {
  try {
    const proc = Bun.spawn(['claude', 'plugin', 'update', 'g2@g2cc', '--json', '-y'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    const timer = setTimeout(() => proc.kill(), INSTALL_TIMEOUT_MS)
    await proc.exited
    clearTimeout(timer)
  } catch {
    // No claude on PATH: a new session still updates through Claude Code's auto-update.
  }
}

/** Starts the periodic check. Returns a stop function. */
export function startSelfUpdate(o: SelfUpdateOptions, everyMs = UPDATE_CHECK_EVERY_MS): () => void {
  const u = new SelfUpdate(o)
  const first = setTimeout(() => void u.check(), Math.min(FIRST_CHECK_AFTER_MS, everyMs))
  const timer = setInterval(() => void u.check(), everyMs)
  first.unref?.()
  timer.unref?.()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
