import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, test } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { AuditCollector } from '../../src/engine/audit.js'
import type { EngineEvent } from '../../src/engine/events.js'
import { ActivityCache } from '../../src/server/activity.js'
import { builtinConnector, builtinConnectors, registerBuiltinConnector, unregisterBuiltinConnector } from '../../src/connectors/builtins.js'
import { ToolBridge, type ConnectorEvent } from '../../src/connectors/bridge.js'

const call = (status: 'ok' | 'refused', agentId = 'a'): EngineEvent => ({
  type: 'agent.connector', runId: 'run', agentId, connectorId: 'slack', at: 42,
  call: {
    id: 'c1', tool: 'search_messages', outcome: status === 'ok' ? 'completed' : 'denied', status,
    argKeys: ['query', 'count'], requestBytes: 31, responseBytes: status === 'ok' ? 2048 : 0, durationMs: 120,
    ...(status === 'refused' ? { error: 'tool not exposed to agents' } : {}),
  },
})

describe('connector evidence', () => {
  test('is frozen with the round as tool-bridge records: metadata only', () => {
    const repos = makeRepos(openDb(':memory:'))
    const audit = new AuditCollector(repos, { now: () => 100 })
    audit.beginRound('run', 'round-1', 1)
    audit.record(call('ok'))
    audit.record(call('refused'))
    audit.record({ type: 'agent.connector', runId: 'run', agentId: 'a', connectorId: 'web', at: 43, note: { kind: 'network', summary: 'fetched https://example.org/' } })
    const { frozen, records } = audit.freeze('run', 'round-1', ['a'])
    const bridge = records.filter((r) => r.source === 'tool_bridge')
    expect(bridge).toEqual([
      expect.objectContaining({ agentId: 'a', kind: 'tool', summary: 'slack: search_messages', outcome: 'completed', detail: 'status ok; 31 B in, 2048 B out; 120 ms; arguments: query, count' }),
      expect.objectContaining({ kind: 'tool', outcome: 'denied', detail: expect.stringContaining('tool not exposed to agents') }),
      expect.objectContaining({ kind: 'network', summary: 'web: fetched https://example.org/' }),
    ])
    expect(frozen.sensors.connector).toMatch(/Argument values and results are not kept/)
    expect(frozen.agents.a!.records).toBe(4)
  })

  test('shows calls on the agent card as tool activity, and keeps notes out of the live feed', () => {
    const cache = new ActivityCache()
    const out = cache.record(call('ok'))
    expect(out).toMatchObject({ type: 'agent.activity', agentId: 'a', kind: 'tool', item: { kind: 'tool', status: 'completed' } })
    expect((out as { detail: string }).detail).toBe('connector slack: search_messages — ok (2048 B, 120 ms)')
    expect(cache.snapshot().agents.a!.items).toHaveLength(1)
    expect(cache.record({ type: 'agent.connector', runId: 'run', agentId: 'a', connectorId: 'web', at: 1, note: { kind: 'tool', summary: 'x' } })).toBeNull()
  })
})

describe('built-in connectors hook', () => {
  afterEach(() => unregisterBuiltinConnector('demo'))

  test('registers read-only in-process servers by connector id rules, once', () => {
    const def = { id: 'demo', title: 'Demo', readOnly: true as const, createServer: () => new McpServer({ name: 'demo', version: '1' }) }
    registerBuiltinConnector(def)
    expect(builtinConnector('demo')).toBe(def)
    expect(builtinConnectors().map((b) => b.id)).toContain('demo')
    expect(() => registerBuiltinConnector(def)).toThrow(/already registered/)
    expect(() => registerBuiltinConnector({ ...def, id: 'external' })).toThrow(/reserved/)
    expect(() => registerBuiltinConnector({ ...def, id: 'other', readOnly: false as never })).toThrow(/read-only/)
  })

  test('a built-in note lands under the calling agent, bounded and redacted', () => {
    const events: ConnectorEvent[] = []
    const bridge = new ToolBridge(undefined, () => 7)
    bridge.grant('g', { runId: () => 'run', connectors: [], maxCallsPerAgent: 1, onEvent: (e) => events.push(e), close: async () => {} })
    bridge.note('g', 'agent-x', 'web', { kind: 'network', summary: `GET https://api.invalid/?token=abc123 ${'y'.repeat(400)}` })
    bridge.note('unknown-grant', 'agent-x', 'web', { summary: 'dropped' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ agentId: 'agent-x', runId: 'run', connectorId: 'web', at: 7, note: { kind: 'network' } })
    expect(events[0]!.note!.summary).not.toContain('abc123')
    expect(events[0]!.note!.summary.length).toBeLessThanOrEqual(300)
  })
})
