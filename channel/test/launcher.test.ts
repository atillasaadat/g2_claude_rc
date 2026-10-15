// The launcher swaps in a newer channel on the same stdio.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Launcher, SWAP_METHOD, SWAP_PROBATION_MS, validSwapTarget, type Child } from '../src/launcher'
import { newestInstalled, SelfUpdate, takeLock } from '../src/self-update'

/** A plugin cache folder with these g2 versions. */
function cache(versions: string[], opts: { channel?: boolean } = {}): Record<string, string> {
  const base = mkdtempSync(join(tmpdir(), 'g2-cache-'))
  const out: Record<string, string> = {}
  for (const v of versions) {
    const root = join(base, v)
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'g2', version: v }))
    if (opts.channel !== false) writeFileSync(join(root, 'dist', 'channel.js'), '')
    out[v] = root
  }
  return out
}

class FakeChild implements Child {
  written: string[] = []
  signals: string[] = []
  private lineCb: (l: string) => void = () => {}
  private exitCb: (c: number | null) => void = () => {}
  constructor(readonly root: string) {}
  write(line: string) {
    this.written.push(line)
  }
  onLine(cb: (l: string) => void) {
    this.lineCb = cb
  }
  onExit(cb: (c: number | null) => void) {
    this.exitCb = cb
  }
  signal(sig: string) {
    this.signals.push(sig)
  }
  closeInput() {
    this.exitCb(0)
  }
  say(msg: object) {
    this.lineCb(JSON.stringify(msg))
  }
  exit(code = 0) {
    this.exitCb(code)
  }
}

function setup(root: string) {
  const children: FakeChild[] = []
  const out: object[] = []
  let exited: number | null = null
  let now = 1_000
  const l = new Launcher(root, {
    spawn: r => {
      const c = new FakeChild(r)
      children.push(c)
      return c
    },
    out: line => out.push(JSON.parse(line)),
    exit: code => void (exited = code),
    log: () => {},
    now: () => now,
  })
  const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } } }
  l.fromParent(JSON.stringify(init))
  children[0]!.say({ jsonrpc: '2.0', id: 0, result: { capabilities: {} } })
  l.fromParent(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
  return { l, children, out, init, exited: () => exited, advance: (ms: number) => void (now += ms) }
}

describe('validSwapTarget', () => {
  test('only a newer g2 version beside this one, with a channel', () => {
    const c = cache(['0.4.7', '0.4.8', '0.4.6'])
    expect(validSwapTarget(c['0.4.7']!, c['0.4.8'])).toBe(true)
    expect(validSwapTarget(c['0.4.7']!, c['0.4.6'])).toBe(false)
    expect(validSwapTarget(c['0.4.7']!, c['0.4.7'])).toBe(false)
    expect(validSwapTarget(c['0.4.7']!, cache(['0.5.0'])['0.5.0'])).toBe(false)
    expect(validSwapTarget(c['0.4.7']!, cache(['0.4.9'], { channel: false })['0.4.9'])).toBe(false)
    expect(validSwapTarget(c['0.4.7']!, 42)).toBe(false)
  })
})

describe('Launcher', () => {
  test('passes lines both ways', () => {
    const c = cache(['1.0.0'])
    const { l, children, out } = setup(c['1.0.0']!)
    l.fromParent('{"jsonrpc":"2.0","id":5,"method":"tools/list"}')
    expect(children[0]!.written.at(-1)).toBe('{"jsonrpc":"2.0","id":5,"method":"tools/list"}')
    children[0]!.say({ jsonrpc: '2.0', id: 5, result: { tools: [] } })
    expect(out.at(-1)).toEqual({ jsonrpc: '2.0', id: 5, result: { tools: [] } })
  })

  test('a swap starts the new channel, replays initialize, drops its answer, and says the tools changed', () => {
    const c = cache(['1.0.0', '1.0.1'])
    const { l, children, out, init } = setup(c['1.0.0']!)
    children[0]!.say({ jsonrpc: '2.0', method: SWAP_METHOD, params: { root: c['1.0.1'] } })
    expect(children[0]!.signals).toEqual(['SIGUSR2'])
    // Lines from Claude Code wait for the new channel.
    l.fromParent('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{}}')
    expect(children.length).toBe(1)
    const outBefore = out.length
    children[0]!.exit(0)
    const next = children[1]!
    expect(next.root).toBe(c['1.0.1']!)
    const [replayed, initialized, held] = next.written.map(x => JSON.parse(x))
    expect(replayed).toEqual({ ...init, id: 'g2-swap-initialize' })
    expect(initialized.method).toBe('notifications/initialized')
    expect(held.method).toBe('notifications/cancelled')
    next.say({ jsonrpc: '2.0', id: 'g2-swap-initialize', result: {} })
    expect(out.slice(outBefore)).toEqual([{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }])
    // The swap message itself never reaches Claude Code.
    expect(JSON.stringify(out)).not.toContain(SWAP_METHOD)
  })

  test('no swap while a request is in flight, or to an invalid target', () => {
    const c = cache(['1.0.0', '1.0.1'])
    const { l, children } = setup(c['1.0.0']!)
    l.fromParent('{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"ask"}}')
    children[0]!.say({ jsonrpc: '2.0', method: SWAP_METHOD, params: { root: c['1.0.1'] } })
    expect(children[0]!.signals).toEqual([])
    children[0]!.say({ jsonrpc: '2.0', id: 9, result: {} })
    // The channel asks Claude Code something (a dialog): also in flight.
    children[0]!.say({ jsonrpc: '2.0', id: 3, method: 'elicitation/create', params: {} })
    children[0]!.say({ jsonrpc: '2.0', method: SWAP_METHOD, params: { root: c['1.0.1'] } })
    expect(children[0]!.signals).toEqual([])
    l.fromParent('{"jsonrpc":"2.0","id":3,"result":{}}')
    children[0]!.say({ jsonrpc: '2.0', method: SWAP_METHOD, params: { root: '/etc' } })
    expect(children[0]!.signals).toEqual([])
    children[0]!.say({ jsonrpc: '2.0', method: SWAP_METHOD, params: { root: c['1.0.1'] } })
    expect(children[0]!.signals).toEqual(['SIGUSR2'])
  })

  test('a new channel that dies at once is replaced by the previous version', () => {
    const c = cache(['1.0.0', '1.0.1'])
    const { children, exited, advance } = setup(c['1.0.0']!)
    children[0]!.say({ jsonrpc: '2.0', method: SWAP_METHOD, params: { root: c['1.0.1'] } })
    children[0]!.exit(0)
    advance(1_000)
    children[1]!.exit(1)
    expect(children[2]!.root).toBe(c['1.0.0']!)
    expect(exited()).toBeNull()
    // Later exits are real.
    advance(SWAP_PROBATION_MS)
    children[2]!.exit(3)
    expect(exited()).toBe(3)
  })

  test('the session ending stops the channel and exits with it', () => {
    const c = cache(['1.0.0'])
    const { l, exited } = setup(c['1.0.0']!)
    l.end()
    expect(exited()).toBe(0)
  })
})

describe('SelfUpdate', () => {
  const opts = (root: string, over: Partial<ConstructorParameters<typeof SelfUpdate>[0]> = {}) => {
    const swaps: string[] = []
    let installs = 0
    const home = mkdtempSync(join(tmpdir(), 'g2-home-'))
    const o = {
      root,
      home,
      busy: () => false,
      requestSwap: (r: string) => void swaps.push(r),
      install: async () => void installs++,
      fetch: async () => new Response(JSON.stringify({ version: '9.9.9' })),
      now: () => Date.now(),
      log: () => {},
      ...over,
    }
    return { u: new SelfUpdate(o), swaps, installs: () => installs, home }
  }

  test('swaps to the newest installed version when idle, without installing', async () => {
    const c = cache(['1.0.0', '1.0.1', '1.0.2'])
    expect(newestInstalled(c['1.0.0']!)).toBe(c['1.0.2']!)
    const { u, swaps, installs } = opts(c['1.0.0']!)
    await u.check()
    expect(swaps).toEqual([c['1.0.2']!])
    expect(installs()).toBe(0)
  })

  test('waits while the session is busy', async () => {
    const c = cache(['1.0.0', '1.0.1'])
    const { u, swaps } = opts(c['1.0.0']!, { busy: () => true })
    await u.check()
    expect(swaps).toEqual([])
  })

  test('a newer release that is not installed runs the installer once, under the lock', async () => {
    const c = cache(['1.0.0'])
    const { u, installs, home } = opts(c['1.0.0']!)
    await u.check()
    await u.check()
    expect(installs()).toBe(1)
    // Another channel holding the lock: nobody else installs.
    const release = takeLock(home, Date.now())!
    expect(takeLock(home, Date.now())).toBeNull()
    release()
    expect(takeLock(home, Date.now())).not.toBeNull()
  })

  test('nothing newer released: no installer', async () => {
    const c = cache(['1.0.0'])
    const { u, installs } = opts(c['1.0.0']!, { fetch: async () => new Response(JSON.stringify({ version: '1.0.0' })) })
    await u.check()
    expect(installs()).toBe(0)
  })
})
