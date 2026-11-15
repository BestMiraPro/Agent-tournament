import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  discoverClaudeCodeServers,
  importedConnector,
  looksSecret,
  maskDiscovered,
  suggestConnectorId,
} from '../../src/connectors/claude-import.js'

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

const SECRET_KEY = 'ctx7sk-SYNTHETIC-0123456789abcdef'
const SECRET_TOKEN = 'ghp_SYNTHETIC0123456789abcdefghij'

/** A fake home with every place Claude Code keeps MCP servers. Synthetic values only. */
function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'arena-claude-home-'))
  homes.push(home)
  const project = join(home, 'code', 'proj')
  mkdirSync(project, { recursive: true })
  const files: Record<string, string> = {
    '.claude.json': JSON.stringify({
      numStartups: 3,
      mcpServers: {
        playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'], env: {} },
        context7: { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: SECRET_KEY } },
        'chrome-devtools': { command: 'npx', args: ['chrome-devtools-mcp@latest', '--api-token', SECRET_TOKEN], env: { DEBUG: '1', API_TOKEN: SECRET_TOKEN, HOME_TOKEN: '${GITHUB_TOKEN}' } },
      },
      projects: { [project]: { mcpServers: { local1: { command: 'node', args: ['server.js'] } } } },
    }),
    '.claude/settings.json': JSON.stringify({ mcpServers: { fromSettings: { type: 'sse', url: `https://example.invalid/sse?api_key=${SECRET_KEY}` } } }),
    'code/proj/.mcp.json': JSON.stringify({ mcpServers: { projectOne: { type: 'http', url: 'https://project.invalid/mcp' } } }),
    '.claude/plugins/cache/market/plug/1.0.0/.mcp.json': JSON.stringify({ pluginServer: { command: '${CLAUDE_PLUGIN_ROOT}/bin/server', args: ['--stdio'] } }),
    '.claude/plugins/cache/market/other/2.0.0/.mcp.json': JSON.stringify({ mcpServers: { wrapped: { type: 'http', url: 'https://plugin.invalid/mcp' } } }),
  }
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(home, rel, '..'), { recursive: true })
    writeFileSync(join(home, rel), content)
  }
  return { home, project, files }
}

describe('discovering Claude Code MCP servers', () => {
  test('finds user, local, settings, project and plugin servers', () => {
    const { home, project } = fakeHome()
    const found = discoverClaudeCodeServers({ home })
    expect(found.map((s) => [s.source, s.name]).sort()).toEqual([
      ['local', 'local1'], ['plugin', 'pluginServer'], ['plugin', 'wrapped'], ['project', 'projectOne'],
      ['settings', 'fromSettings'], ['user', 'chrome-devtools'], ['user', 'context7'], ['user', 'playwright'],
    ])
    const plugin = found.find((s) => s.name === 'pluginServer')!
    expect(plugin.transport).toEqual({ type: 'stdio', command: join(home, '.claude/plugins/cache/market/plug/1.0.0', 'bin/server'), args: ['--stdio'], env: {} })
    expect(found.find((s) => s.name === 'local1')!.sourcePath).toBe(`${join(home, '.claude.json')}#${project}`)
    expect(new Set(found.map((s) => s.key)).size).toBe(found.length)
  })

  test('never changes the files it reads', () => {
    const { home, files } = fakeHome()
    const before = Object.keys(files).map((rel) => ({ rel, content: readFileSync(join(home, rel), 'utf8'), mtime: statSync(join(home, rel)).mtimeMs }))
    discoverClaudeCodeServers({ home })
    for (const b of before) {
      expect(readFileSync(join(home, b.rel), 'utf8')).toBe(b.content)
      expect(statSync(join(home, b.rel)).mtimeMs).toBe(b.mtime)
    }
  })

  test('a home without Claude Code finds nothing, and a broken file is skipped', () => {
    const home = mkdtempSync(join(tmpdir(), 'arena-claude-empty-'))
    homes.push(home)
    expect(discoverClaudeCodeServers({ home })).toEqual([])
    writeFileSync(join(home, '.claude.json'), '{ not json')
    expect(discoverClaudeCodeServers({ home })).toEqual([])
  })

  test('what the dashboard is shown has every credential masked', () => {
    const { home } = fakeHome()
    const shown = JSON.stringify(discoverClaudeCodeServers({ home }).map(maskDiscovered))
    expect(shown).not.toContain(SECRET_KEY)
    expect(shown).not.toContain(SECRET_TOKEN)
    expect(shown).toContain('chrome-devtools-mcp@latest')
    expect(shown).toContain('${GITHUB_TOKEN}')
  })
})

describe('importing a discovered server', () => {
  test('stdio: secret env values and arguments move to the secrets file; references stay', () => {
    const { home } = fakeHome()
    const server = discoverClaudeCodeServers({ home }).find((s) => s.name === 'chrome-devtools')!
    const { record, secrets } = importedConnector(server, 'chrome-devtools', 7)
    expect(record.transport).toEqual({
      type: 'stdio', command: 'npx', args: ['chrome-devtools-mcp@latest', '--api-token', '${ARENA_SECRET_ARG_1}'],
      env: { DEBUG: '1', HOME_TOKEN: '${GITHUB_TOKEN}' }, secretEnv: ['API_TOKEN'],
    })
    expect(secrets).toEqual({ env: { API_TOKEN: SECRET_TOKEN }, args: { ARENA_SECRET_ARG_1: SECRET_TOKEN } })
    expect(record.origin).toEqual({ type: 'imported', source: `user:${join(home, '.claude.json')}`, name: 'chrome-devtools' })
    expect(JSON.stringify(record)).not.toContain(SECRET_TOKEN)
  })

  test('http: secret headers and credential-bearing URLs move to the secrets file; no auth header means MCP OAuth', () => {
    const { home } = fakeHome()
    const found = discoverClaudeCodeServers({ home })
    const ctx7 = importedConnector(found.find((s) => s.name === 'context7')!, 'context7', 1)
    expect(ctx7.record.transport).toEqual({ type: 'http', url: 'https://mcp.context7.com/mcp', headers: {}, secretHeaders: ['CONTEXT7_API_KEY'] })
    expect(ctx7.secrets).toEqual({ headers: { CONTEXT7_API_KEY: SECRET_KEY } })
    expect(ctx7.record.auth).toEqual({ type: 'oauth-mcp' })
    const sse = importedConnector(found.find((s) => s.name === 'fromSettings')!, 'from-settings', 1)
    expect(sse.record.transport).toMatchObject({ type: 'http', url: null })
    expect(sse.secrets.url).toContain(SECRET_KEY)
    expect(JSON.stringify(sse.record)).not.toContain(SECRET_KEY)
  })

  test('suggests a free, valid, unreserved id', () => {
    expect(suggestConnectorId('chrome-devtools', new Set())).toBe('chrome-devtools')
    expect(suggestConnectorId('My Server_v2', new Set())).toBe('my-server-v2')
    expect(suggestConnectorId('playwright', new Set(['playwright']))).toBe('playwright-2')
    expect(suggestConnectorId('7zip', new Set())).toBe('mcp-7zip')
    expect(suggestConnectorId('external', new Set())).toBe('external-mcp')
  })

  test('secret detection: names and values, never a plain path or an env reference', () => {
    for (const [name, value] of [['GITHUB_TOKEN', 'x'], ['API_KEY', 'x'], ['Authorization', 'Bearer y'], ['X', 'xoxp-1-2'], ['X', 'a'.repeat(20) + '1234567890abcdefgh']]) {
      expect(looksSecret(name!, value!)).toBe(true)
    }
    for (const [name, value] of [['PATH', '/usr/bin'], ['DEBUG', '1'], ['GITHUB_TOKEN', '${GITHUB_TOKEN}'], ['NODE_ENV', 'production'], ['X', '']]) {
      expect(looksSecret(name!, value!)).toBe(false)
    }
  })
})
