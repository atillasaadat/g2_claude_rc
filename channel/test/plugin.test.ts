import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const json = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'))

describe('plugin package', () => {
  test('plugin hooks match the settings snippet', () => {
    expect(json('plugin/hooks/hooks.json').hooks).toEqual(json('channel/settings.example.json').hooks)
  })

  test('every hook is an http hook to the fixed port with a short timeout', () => {
    const hooks = json('plugin/hooks/hooks.json').hooks as Record<string, { hooks: { type: string; url: string; timeout: number }[] }[]>
    expect(Object.keys(hooks).sort()).toEqual(['Notification', 'PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit'])
    for (const groups of Object.values(hooks))
      for (const h of groups.flatMap(g => g.hooks)) expect(h).toEqual({ type: 'http', url: 'http://127.0.0.1:27183/hook', timeout: 2 })
  })

  test('the MCP server is named g2 and runs the bundle', () => {
    expect(json('plugin/.mcp.json').mcpServers.g2).toEqual({ command: 'bun', args: ['${CLAUDE_PLUGIN_ROOT}/dist/server.js'] })
    expect(json('plugin/.claude-plugin/plugin.json').name).toBe('g2')
    expect(json('.claude-plugin/marketplace.json').plugins[0]).toMatchObject({ name: 'g2', source: './plugin' })
  })
})
