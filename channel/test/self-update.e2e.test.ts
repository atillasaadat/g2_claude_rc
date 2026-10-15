// The built plugin, installed at two versions in a fake plugin cache: a
// session started on the older one moves to the newer one on its own, on the
// same stdio, without Claude Code restarting anything.
import { afterAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN = join(import.meta.dir, '..', '..', 'plugin')
const SID = '11111111-2222-4333-8444-555555555555'
const tmp = mkdtempSync(join(tmpdir(), 'g2-selfupdate-'))
let proc: ReturnType<typeof Bun.spawn> | null = null
afterAll(() => {
  proc?.kill()
  rmSync(tmp, { recursive: true, force: true })
})

function install(version: string): string {
  const root = join(tmp, 'cache', 'g2cc', 'g2', version)
  cpSync(PLUGIN, root, { recursive: true })
  const manifest = join(root, '.claude-plugin', 'plugin.json')
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), version }))
  return root
}

test('a running session swaps to a newer installed version when idle', async () => {
  const old = install('1.0.0')
  const home = join(tmp, 'g2cc')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  // The release check is answered from its cache: nothing to install, 1.0.1 is already there.
  writeFileSync(join(home, 'latest-version.json'), JSON.stringify({ checkedAt: Date.now(), latest: '1.0.1' }))
  proc = Bun.spawn(['bun', join(old, 'dist', 'server.js')], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: old,
      CLAUDE_CODE_SESSION_ID: SID,
      CLAUDE_PROJECT_DIR: '/tmp/demo-repo',
      G2CC_HOME: home,
      G2CC_RELAY_URL: 'ws://127.0.0.1:9',
      G2CC_UPDATE_CHECK_MS: '300',
    },
  })
  const lines: Array<Record<string, unknown>> = []
  let stderr = ''
  void (async () => {
    let buf = ''
    for await (const c of proc!.stdout as ReadableStream<Uint8Array>) {
      buf += new TextDecoder().decode(c)
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)))
        buf = buf.slice(i + 1)
      }
    }
  })()
  void (async () => {
    for await (const c of proc!.stderr as ReadableStream<Uint8Array>) stderr += new TextDecoder().decode(c)
  })()
  const send = (m: object) => {
    const stdin = proc!.stdin as import('bun').FileSink
    stdin.write(JSON.stringify(m) + '\n')
    void stdin.flush()
  }
  const until = async (pred: () => boolean, what: string, ms = 15_000) => {
    const end = Date.now() + ms
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out: ${what}\n${stderr}`)
      await Bun.sleep(50)
    }
  }

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
  await until(() => lines.some(l => l.id === 1), 'initialize answer')
  expect(JSON.stringify(lines.find(l => l.id === 1))).toContain('claude/channel')
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  await until(() => existsSync(join(home, 'sessions', `${SID}.sock`)), 'hook socket')

  // Claude Code's installer puts a newer version beside it.
  const next = install('1.0.1')
  await until(() => lines.some(l => l.method === 'notifications/tools/list_changed'), 'swap', 20_000)
  expect(stderr).toContain(`swapping to ${next}`)
  // Exactly one initialize answer reached Claude Code; the swap message never did.
  expect(lines.filter(l => l.id === 1).length).toBe(1)
  expect(JSON.stringify(lines)).not.toContain('g2/swap')

  // The new channel answers on the same stdio and serves the hooks again.
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  await until(() => lines.some(l => l.id === 2), 'tools/list from the new channel')
  expect(JSON.stringify(lines.find(l => l.id === 2))).toContain('glance')
  await until(() => existsSync(join(home, 'sessions', `${SID}.sock`)), 'hook socket after the swap')

  // The session ending still ends everything.
  ;(proc.stdin as import('bun').FileSink).end()
  expect(await proc.exited).toBe(0)
}, 60_000)
