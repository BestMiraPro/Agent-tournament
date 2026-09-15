import { describe, expect, test } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import {
  AUDIT_FROZEN_EVENT,
  AuditCollector,
  readRoundAudit,
  type AuditEvidence,
} from '../../src/engine/audit.js'
import type { ActivityItemInput, EngineEvent } from '../../src/engine/events.js'
import { makeMockEngine } from '../helpers/mock-engine.js'

const setup = (limits = {}) => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  let clock = 1_000
  const audit = new AuditCollector(repos, {
    limits,
    provenance: { sandbox: 'docker', isolation: 'protected', toolchainId: 'tc-1' },
    now: () => ++clock,
  })
  audit.beginRound('run', 'round-1', 1)
  return { db, repos, audit }
}

const tool = (agentId: string, item: Partial<ActivityItemInput> & { id: string }): EngineEvent => ({
  type: 'agent.activity', runId: 'run', agentId, kind: 'tool', detail: '',
  item: { sessionId: 'ses', kind: 'tool', summary: 'bash: ls', observedAt: 5, ...item },
})

const byAgent = (records: AuditEvidence[], agentId: string | null) => records.filter((r) => r.agentId === agentId)

describe('AuditCollector', () => {
  test('a tool call is written once, when it settles, and a later update never rewrites it', () => {
    const { repos, audit } = setup()
    audit.record(tool('a', { id: 't1', status: 'running', summary: 'bash' }))
    audit.record(tool('a', { id: 't1', status: 'completed', summary: 'bash: python fib.py', output: '0\n1\n1' }))
    audit.record(tool('a', { id: 't1', status: 'error', output: 'later noise' }))
    const { records } = audit.freeze('run', 'round-1', ['a'])
    const tools = records.filter((r) => r.kind === 'tool')
    expect(tools).toEqual([expect.objectContaining({
      id: 'E1', agentId: 'a', sessionId: 'ses', source: 'provider_stream', kind: 'tool',
      summary: 'bash: python fib.py', outcome: 'completed', detail: '0\n1\n1',
    })])
    expect(repos.events.forRound('round-1', ['audit.evidence']).length).toBe(records.length)
  })

  test('a call a permission rule refused is recorded as a denied policy decision', () => {
    const { audit } = setup()
    audit.record(tool('a', {
      id: 't1', status: 'error', summary: 'read: /context/BRIEF.md',
      output: 'The user has specified a rule which prevents you from using this specific tool call. …',
    }))
    const denied = audit.freeze('run', 'round-1', ['a']).records.find((r) => r.kind === 'tool')
    expect(denied).toMatchObject({ source: 'policy', outcome: 'denied', summary: 'read: /context/BRIEF.md' })
  })

  test('permissions: a reply settles the request; an unanswered one is unknown at the freeze', () => {
    const { audit } = setup()
    audit.record({ type: 'agent.permission', runId: 'run', agentId: 'a', requestId: 'p1', state: 'asked', permission: 'external_directory', patterns: ['/tmp/*'], at: 10 })
    audit.record({ type: 'agent.permission', runId: 'run', agentId: 'a', requestId: 'p1', state: 'replied', reply: 'reject', at: 11 })
    audit.record({ type: 'agent.permission', runId: 'run', agentId: 'a', requestId: 'p2', state: 'asked', permission: 'bash', at: 12 })
    const perms = audit.freeze('run', 'round-1', ['a']).records.filter((r) => r.kind === 'permission')
    expect(perms).toEqual([
      expect.objectContaining({ summary: 'external_directory /tmp/*', outcome: 'denied', observedAt: 11 }),
      expect.objectContaining({ summary: 'bash', outcome: 'unknown', detail: 'No reply was observed before judging.' }),
    ])
  })

  test('failures and stream gaps are evidence; agent text is not', () => {
    const { audit } = setup()
    audit.record({ type: 'agent.activity', runId: 'run', agentId: 'a', kind: 'text', detail: 'hi', item: { id: 'x', sessionId: 's', kind: 'text', summary: 'thinking aloud', observedAt: 1 } })
    audit.record({ type: 'agent.status', runId: 'run', agentId: 'a', roundIdx: 1, status: 'failed', failure: { code: 'DRIVER_TIMEOUT', message: 'Driver timeout after 600000ms' } as never })
    audit.record({ type: 'agent.status', runId: 'run', agentId: 'a', roundIdx: 0, status: 'failed' })
    audit.record({ type: 'bridge.status', runId: 'run', source: 'shard-0', state: 'reconnecting', message: 'socket closed', at: 20 })
    const { records, frozen } = audit.freeze('run', 'round-1', ['a'])
    expect(records.some((r) => r.summary === 'thinking aloud')).toBe(false)
    expect(records.filter((r) => r.kind === 'failure')).toEqual([
      expect.objectContaining({ source: 'runtime', outcome: 'failed', summary: 'DRIVER_TIMEOUT: Driver timeout after 600000ms' }),
    ])
    expect(byAgent(records, null)).toEqual([expect.objectContaining({ id: 'R1', kind: 'gap', summary: expect.stringContaining('shard-0') })])
    expect(frozen.streamGaps).toBe(1)
  })

  test('secrets are redacted and long output is cut to its bound, and the cut is counted', () => {
    const { audit } = setup()
    audit.record(tool('a', { id: 't1', status: 'completed', summary: 'bash: curl -H "Authorization: Bearer sk-live-123" x', output: `api_key=sk-9 ${'y'.repeat(5000)}` }))
    const { records, frozen } = audit.freeze('run', 'round-1', ['a'])
    const t = records.find((r) => r.kind === 'tool')!
    expect(JSON.stringify(t)).not.toMatch(/sk-live-123|sk-9/)
    expect(Buffer.byteLength(t.detail!)).toBeLessThanOrEqual(2048)
    expect(frozen.agents.a!.truncated).toBe(1)
  })

  test('at the per-agent cap further records are counted, not kept, and the loss is stated', () => {
    const { audit } = setup({ maxRecordsPerAgent: 2 })
    for (const id of ['t1', 't2', 't3', 't4']) audit.record(tool('a', { id, status: 'completed' }))
    const { records, frozen } = audit.freeze('run', 'round-1', ['a'])
    expect(records.filter((r) => r.kind === 'tool')).toHaveLength(2)
    expect(frozen.agents.a!.dropped).toBe(2)
    expect(records).toContainEqual(expect.objectContaining({ kind: 'gap', summary: expect.stringContaining('2 further record(s)') }))
  })

  test('freeze settles open calls, lists silent agents, adds capture integrity and seals a digest', () => {
    const { repos, audit } = setup()
    repos.events.append({ runId: 'run', roundId: 'round-1', agentId: 'a', type: 'submission.captured', payload: { sealed: true, verified: true, tampered: false } })
    repos.events.append({ runId: 'run', roundId: 'round-1', agentId: 'b', type: 'submission.captured', payload: { sealed: false, verified: false, tampered: false } })
    audit.record(tool('a', { id: 't1', status: 'running', summary: 'bash: sleep 999' }))
    const { frozen, records } = audit.freeze('run', 'round-1', ['a', 'b', 'c'])

    expect(records).toContainEqual(expect.objectContaining({ agentId: 'a', kind: 'tool', outcome: 'unknown', detail: 'No final state was observed before judging.' }))
    expect(records.filter((r) => r.kind === 'integrity').map((r) => [r.agentId, r.outcome])).toEqual([
      ['a', 'completed'], ['b', 'unknown'], ['c', 'unknown'],
    ])
    expect(frozen.agents).toEqual({
      a: { records: 2, dropped: 0, truncated: 0, capture: { sealed: true, verified: true, tampered: false } },
      b: { records: 1, dropped: 0, truncated: 0, capture: { sealed: false, verified: false, tampered: false } },
      c: { records: 1, dropped: 0, truncated: 0, capture: null },
    })
    expect(frozen.provenance).toEqual({ sandbox: 'docker', isolation: 'protected', toolchainId: 'tc-1' })
    expect(frozen.sensors.network).toMatch(/^Not observed/)
    expect(repos.events.forRound('round-1', [AUDIT_FROZEN_EVENT])).toHaveLength(1)
  })

  test('evidence after the freeze is late and never changes the frozen set', () => {
    const { repos, audit } = setup()
    audit.record(tool('a', { id: 't1', status: 'completed' }))
    const { frozen } = audit.freeze('run', 'round-1', ['a'])
    audit.record(tool('a', { id: 't2', status: 'completed', summary: 'bash: rm -rf /work' }))
    const view = readRoundAudit(repos, 'round-1')
    expect(view.status).toBe('recorded')
    expect(view.frozen!.digest).toBe(frozen.digest)
    expect(view.digestMatches).toBe(true)
    expect(view.records.some((r) => r.summary === 'bash: rm -rf /work')).toBe(false)
    expect(view.late).toEqual([expect.objectContaining({ summary: 'bash: rm -rf /work' })])
  })

  test('a changed stored record no longer matches the digest', () => {
    const { db, repos, audit } = setup()
    audit.record(tool('a', { id: 't1', status: 'completed', summary: 'bash: ls' }))
    audit.freeze('run', 'round-1', ['a'])
    db.prepare("UPDATE events SET payload_json = replace(payload_json, 'bash: ls', 'bash: pwd') WHERE type = 'audit.evidence'").run()
    expect(readRoundAudit(repos, 'round-1').digestMatches).toBe(false)
  })

  test('a round with no audit says so, and a failing write never throws into the round', () => {
    const { repos } = setup()
    expect(readRoundAudit(repos, 'legacy-round')).toEqual({ status: 'not_recorded', frozen: null, records: [], late: [], digestMatches: null })
    const broken = new AuditCollector({ events: { ...repos.events, append: () => { throw new Error('disk full') } } })
    broken.beginRound('run', 'round-2', 1)
    expect(() => broken.record(tool('a', { id: 't1', status: 'completed' }))).not.toThrow()
  })
})

describe('the engine and the audit', () => {
  test('a round freezes every agent\'s evidence before judging, and the record survives a fresh read', async () => {
    const db = openDb(':memory:')
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, audit: (r) => new AuditCollector(r), db })
    const run = engine.createRun('audit', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const view = readRoundAudit(makeRepos(db), round.roundId)
    const agents = repos.agents.listActive(run.id).map((a) => a.id)
    expect(view.status).toBe('recorded')
    expect(Object.keys(view.frozen!.agents).sort()).toEqual([...agents].sort())
    expect(view.records.filter((r) => r.kind === 'integrity')).toHaveLength(3)
    expect(view.digestMatches).toBe(true)
  })
})
