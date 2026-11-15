import { describe, expect, test } from 'vitest'
import { serializeCompetitorProfile } from '../../../src/core/genome.js'
import { MockSandbox } from '../../../src/runtime/mock-sandbox.js'
import { OpenCodeAgentRunner } from '../../../src/runtime/opencode/agent-runner.js'
import { opencodeMcpConfig, OPENCODE_MCP_TIMEOUT_MS, PROJECT_CONFIG_FILE } from '../../../src/runtime/opencode/mcp-config.js'
import { buildToolManifest, renderToolsMarkdown, type ImageInventory } from '../../../src/runtime/tool-manifest.js'
import type { PromptResponse } from '../../../src/runtime/opencode/client.js'

describe('per-agent OpenCode connector config', () => {
  test('each connector is a remote MCP server at the bridge with the agent\'s bearer header, OAuth off', () => {
    const json = JSON.parse(opencodeMcpConfig([
      { id: 'gh', title: 'GitHub', url: 'http://gateway:8788/mcp/gh', headers: { Authorization: 'Bearer tok-a' } },
      { id: 'slack', title: 'Slack', url: 'http://127.0.0.1:40000/mcp/slack', headers: { Authorization: 'Bearer tok-a' } },
    ]))
    expect(json).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        gh: { type: 'remote', url: 'http://gateway:8788/mcp/gh', enabled: true, oauth: false, headers: { Authorization: 'Bearer tok-a' }, timeout: OPENCODE_MCP_TIMEOUT_MS },
        slack: { type: 'remote', url: 'http://127.0.0.1:40000/mcp/slack', enabled: true, oauth: false, headers: { Authorization: 'Bearer tok-a' }, timeout: OPENCODE_MCP_TIMEOUT_MS },
      },
    })
    expect(OPENCODE_MCP_TIMEOUT_MS).toBeGreaterThan(60_000)
  })

  test('refuses anything but a plain bridge endpoint', () => {
    for (const url of ['https://api.githubcopilot.com/mcp/', 'http://u:p@h:1/mcp/gh', 'http://h:1/mcp/gh?x=1', 'http://h:1/mcp/other', 'not a url']) {
      expect(() => opencodeMcpConfig([{ id: 'gh', title: 'g', url, headers: {} }])).toThrow()
    }
    expect(() => opencodeMcpConfig([{ id: 'Bad_Id', title: 'g', url: 'http://h:1/mcp/Bad_Id', headers: {} }])).toThrow(/plain connector id/)
  })
})

describe('the runner writes the agent\'s project config before its session starts', () => {
  const ok: PromptResponse = { info: { cost: 0, tokens: { total: 1, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] }
  const ctx = { agentId: 'a1', genome: { strategyMd: 's', notesMd: '', modelId: 'opencode/big-pickle', temperature: 0.7 }, goalMd: 'g', timeoutMs: 5000 }

  test('written into .opencode/opencode.json, first', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    const order: string[] = []
    const client = {
      async createSession() { order.push(`session:${await sb.readFile(h, PROJECT_CONFIG_FILE)}`); return { id: 'ses_1' } },
      async prompt() { return ok },
      async abort() {},
    }
    await new OpenCodeAgentRunner(client as never, sb, { projectConfig: (handle) => `config for ${handle.agentId}` }).run(h, ctx)
    expect(order).toEqual(['session:config for a1'])
  })

  test('a config that cannot be built fails the agent before any session', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    let sessions = 0
    const client = { async createSession() { sessions++; return { id: 's' } }, async prompt() { return ok }, async abort() {} }
    const result = await new OpenCodeAgentRunner(client as never, sb, { projectConfig: () => { throw new Error('grant revoked') } }).run(h, ctx)
    expect(result.status).toBe('error')
    expect(result.failure?.code).toBe('CONNECTOR_SETUP')
    expect(sessions).toBe(0)
  })
})

describe('competitor profile with connectors', () => {
  const genome = { strategyMd: '', notesMd: '', modelId: 'w/m', temperature: 0.7 }
  test('allows each enabled connector\'s tools by prefix, after the built-in rules', () => {
    const md = serializeCompetitorProfile(genome, { label: 'c', connectorIds: ['slack', 'gh', 'gh'] })
    const head = md.split('\n---')[0]!
    expect(head.endsWith('  "gh_*": allow\n  "slack_*": allow')).toBe(true)
    expect(serializeCompetitorProfile(genome, { label: 'c' })).not.toContain('_*')
  })
})

describe('TOOLS.md with connectors', () => {
  const inventory: ImageInventory = {
    schemaVersion: 1, toolchainId: 't', python: { version: '3.11', venv: '/v', executable: '/v/bin/python' },
    tools: ['python3', 'node', 'git', 'opencode', 'rg'].map((name) => ({ name, version: '1', executable: `/usr/bin/${name}` })),
    pythonPackages: [],
  }
  test('lists each connector and the tools agents can call, marking any that change data', () => {
    const m = buildToolManifest({
      runId: 'r', containerId: 'c', inventory, data: [], packageInstall: 'not_enforced',
      connectors: [{ id: 'gh', title: 'GitHub', tools: [{ name: 'gh_search_code', description: 'Search code', write: false }, { name: 'gh_create_issue', description: '', write: true }] }],
    })
    const md = renderToolsMarkdown(m)
    expect(md).toContain('### GitHub (`gh`)')
    expect(md).toContain('- `gh_search_code` — Search code')
    expect(md).toContain('- `gh_create_issue` (changes data)')
    expect(renderToolsMarkdown(buildToolManifest({ runId: 'r', containerId: 'c', inventory, data: [], packageInstall: 'not_enforced' }))).not.toContain('Connectors')
  })
})
