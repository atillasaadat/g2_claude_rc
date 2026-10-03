// Runs the real command hook (hook.ts) as Claude Code would: payload on
// stdin, answer on stdout. Empty stdout reads as {} ("no decision").

import { join } from 'node:path'

const HOOK = join(import.meta.dir, '..', 'hook.ts')

export async function runHook(home: string, payload: Record<string, unknown>): Promise<Response> {
  const p = Bun.spawn(['bun', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: { ...process.env, G2CC_HOME: home } })
  p.stdin.write(JSON.stringify(payload))
  await p.stdin.end()
  const out = (await new Response(p.stdout).text()).trim()
  const code = await p.exited
  return new Response(out || '{}', { status: code === 0 ? 200 : 500, headers: { 'Content-Type': 'application/json' } })
}
