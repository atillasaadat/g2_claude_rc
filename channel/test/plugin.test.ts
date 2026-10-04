import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const json = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'))

describe('plugin package', () => {
  test('plugin hooks match the from-source settings snippet, apart from the script path', () => {
    const { SessionStart: _bunCheck, ...forwarded } = json('plugin/hooks/hooks.json').hooks
    const plugin = JSON.stringify(forwarded).replaceAll('${CLAUDE_PLUGIN_ROOT}/dist/hook.js', 'HOOK')
    const source = JSON.stringify(json('channel/settings.example.json').hooks).replaceAll('__G2CC_ROOT__/channel/hook.ts', 'HOOK')
    expect(plugin).toBe(source)
  })

  test('every hook runs the bundled command hook in exec form, with a short timeout', () => {
    const { SessionStart: _bunCheck, ...hooks } = json('plugin/hooks/hooks.json').hooks as Record<string, { hooks: unknown[] }[]>
    expect(Object.keys(hooks).sort()).toEqual(['Notification', 'PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit'])
    for (const groups of Object.values(hooks))
      for (const h of groups.flatMap(g => g.hooks))
        expect(h).toEqual({ type: 'command', command: 'bun', args: ['${CLAUDE_PLUGIN_ROOT}/dist/hook.js'], timeout: 3 })
  })

  test('the plugin pins a version, so users update on releases rather than on every push', () => {
    expect(json('plugin/.claude-plugin/plugin.json').version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('the MCP server is named g2 and runs the bundle', () => {
    expect(json('plugin/.mcp.json').mcpServers.g2).toEqual({ command: 'bun', args: ['${CLAUDE_PLUGIN_ROOT}/dist/server.js'] })
    expect(json('plugin/.claude-plugin/plugin.json').name).toBe('g2')
    expect(json('.claude-plugin/marketplace.json').plugins[0]).toMatchObject({ name: 'g2', source: './plugin' })
  })

  test('SessionStart warns, as a message to the user, only when Bun is missing', async () => {
    const [group] = json('plugin/hooks/hooks.json').hooks.SessionStart as { hooks: { command: string }[] }[]
    const cmd = group!.hooks[0]!.command
    const run = (PATH: string) => Bun.spawnSync(['/bin/sh', '-c', cmd], { env: { PATH } })
    expect(run(process.env.PATH ?? '').stdout.toString()).toBe('')
    const out = run('/usr/bin:/bin').stdout.toString().trim()
    expect(JSON.parse(out).systemMessage).toContain('https://bun.sh')
  })
})
