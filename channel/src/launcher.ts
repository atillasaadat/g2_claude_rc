// The plugin's MCP entry point. Claude Code talks to this process over stdio,
// and it runs the channel itself as a child process, passing every line
// through. That lets a running session move to a newer plugin version
// without /reload-plugins: when the channel finds a newer version installed
// and nothing is in flight, it asks for a swap (a `g2/swap` message, never
// forwarded), and the launcher starts the new channel on the same stdio.
//
// The swap only ever runs a version that Claude Code's own installer put next
// to this one in the plugin cache. The launcher replays the session's
// `initialize` to the new channel and drops its answer, since Claude Code
// already has one, then says the tool list may have changed.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isNewer } from './version-check'

export const SWAP_METHOD = 'g2/swap'
const REPLAY_ID = 'g2-swap-initialize'
/** A swapped-in channel that exits this soon is given up on: the previous version comes back. */
export const SWAP_PROBATION_MS = 15_000

type Json = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: unknown }

export interface Child {
  write(line: string): void
  /** Lines the channel prints on stdout, without the newline. */
  onLine(cb: (line: string) => void): void
  onExit(cb: (code: number | null) => void): void
  signal(sig: NodeJS.Signals): void
  closeInput(): void
}

export interface LauncherIo {
  spawn(root: string): Child
  /** To Claude Code, one JSON message per line. */
  out(line: string): void
  exit(code: number): void
  log(msg: string): void
  now(): number
}

/** The plugin version in `root` (its .claude-plugin/plugin.json), or null. */
export function pluginVersion(root: string): string | null {
  try {
    const m = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')) as { name?: unknown; version?: unknown }
    return m.name === 'g2' && typeof m.version === 'string' ? m.version : null
  } catch {
    return null
  }
}

/**
 * A swap target is valid if it is another version directory beside `current`
 * (the same plugin cache folder), holds the g2 plugin at a newer version, and
 * has a channel to run.
 */
export function validSwapTarget(current: string, target: unknown): target is string {
  if (typeof target !== 'string') return false
  const t = resolve(target)
  const cur = resolve(current)
  if (dirname(t) !== dirname(cur) || t === cur) return false
  const [vt, vc] = [pluginVersion(t), pluginVersion(cur)]
  return vt !== null && vc !== null && isNewer(vt, vc) && existsSync(join(t, 'dist', 'channel.js'))
}

export class Launcher {
  private child: Child
  private root: string
  private previousRoot: string | null = null
  private swappedAt = 0
  private initialize: Json | null = null
  private initialized: Json | null = null
  /** Requests from Claude Code the channel has not answered, and the other way round. */
  private readonly fromClaude = new Set<string>()
  private readonly fromChannel = new Set<string>()
  /** Lines from Claude Code held back while the channel is being replaced. */
  private held: string[] | null = null
  private swallowId: string | null = null
  private ending = false

  constructor(
    root: string,
    private readonly io: LauncherIo,
  ) {
    this.root = root
    this.child = this.start(root)
  }

  /** A line from Claude Code. */
  fromParent(line: string): void {
    if (!line.trim()) return
    const msg = parse(line)
    if (msg?.method === 'initialize') this.initialize = msg
    if (msg?.method === 'notifications/initialized') this.initialized = msg
    if (msg && msg.id != null && msg.method) this.fromClaude.add(key(msg.id))
    if (msg && msg.id != null && !msg.method) this.fromChannel.delete(key(msg.id))
    if (this.held) this.held.push(line)
    else this.child.write(line)
  }

  /** Claude Code closed stdin (the session ended), or a signal: stop the channel, then exit. */
  end(sig?: NodeJS.Signals): void {
    this.ending = true
    if (sig) this.child.signal(sig)
    else this.child.closeInput()
  }

  private start(root: string): Child {
    const child = this.io.spawn(root)
    child.onLine(line => this.fromChild(child, line))
    child.onExit(code => this.childExited(child, code))
    return child
  }

  private fromChild(child: Child, line: string): void {
    if (child !== this.child || !line.trim()) return
    const msg = parse(line)
    if (msg?.method === SWAP_METHOD) {
      this.swap((msg.params as { root?: unknown } | undefined)?.root)
      return
    }
    if (msg && this.swallowId !== null && msg.id === this.swallowId && !msg.method) {
      this.swallowId = null
      return
    }
    if (msg && msg.id != null && msg.method) this.fromChannel.add(key(msg.id))
    if (msg && msg.id != null && !msg.method) this.fromClaude.delete(key(msg.id))
    this.io.out(line)
  }

  private swap(target: unknown): void {
    if (this.held || this.ending || !this.initialize) return
    if (!validSwapTarget(this.root, target)) return this.io.log('swap refused: not a newer g2 version beside this one')
    // A request in flight would lose its answer. The channel asks again later.
    if (this.fromClaude.size || this.fromChannel.size) return this.io.log('swap deferred: requests in flight')
    this.held = []
    this.previousRoot = this.root
    this.root = resolve(target)
    // SIGUSR2: stop without telling the glasses the session ended.
    this.child.signal('SIGUSR2')
  }

  private childExited(child: Child, code: number | null): void {
    if (child !== this.child) return
    if (this.ending) return this.io.exit(code ?? 0)
    if (this.held) {
      // The old channel stopped for a swap: start the new one.
      this.io.log(`swapping to ${this.root}`)
      this.swappedAt = this.io.now()
      this.replace()
      return
    }
    if (this.previousRoot && this.io.now() - this.swappedAt < SWAP_PROBATION_MS) {
      this.io.log('the new channel exited at once: going back to the previous version')
      this.root = this.previousRoot
      this.previousRoot = null
      this.held = []
      this.replace()
      return
    }
    this.io.exit(code ?? 1)
  }

  private replace(): void {
    // The request sets stay: they were empty at the swap, and what came since is in `held`.
    this.child = this.start(this.root)
    if (this.initialize) {
      this.swallowId = REPLAY_ID
      this.child.write(JSON.stringify({ ...this.initialize, id: REPLAY_ID }))
    }
    if (this.initialized) this.child.write(JSON.stringify(this.initialized))
    const held = this.held ?? []
    this.held = null
    for (const line of held) this.child.write(line)
    // The new version may bring other tools.
    this.io.out(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }))
  }
}

function parse(line: string): Json | null {
  try {
    const v = JSON.parse(line) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null
  } catch {
    return null
  }
}

const key = (id: string | number): string => `${typeof id}:${id}`
