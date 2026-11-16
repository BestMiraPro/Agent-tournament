import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { AuditCollector } from '../../src/engine/audit.js'
import { ClaudeStreamTranslator } from '../../src/runtime/claude-code/stream.js'

describe('audit of a Claude Code agent', () => {
  test('its permission refusals are denied policy decisions and its tool calls are evidence, as on the OpenCode path', () => {
    const repos = makeRepos(openDb(':memory:'))
    const audit = new AuditCollector(repos, { provenance: { sandbox: 'local', isolation: null, toolchainId: null }, now: () => 1 })
    audit.beginRound('run', 'round-1', 1)
    const translator = new ClaudeStreamTranslator(() => 5)
    const stream = readFileSync(join(import.meta.dirname, '../fixtures/claude-code-2.1.325/fake-upstream-tools.jsonl'), 'utf8')
    for (const line of stream.trim().split('\n')) {
      for (const effect of translator.feed(JSON.parse(line))) {
        if (effect.type === 'activity') audit.record({ type: 'agent.activity', runId: 'run', agentId: 'a', kind: effect.kind, detail: effect.detail, item: effect.item })
      }
    }
    const tools = audit.freeze('run', 'round-1', ['a']).records.filter((r) => r.kind === 'tool')
    const byOutcome = (outcome: string) => tools.filter((r) => r.outcome === outcome).map((r) => r.summary)
    expect(byOutcome('denied')).toEqual([
      'Write: /work/run/outside.txt',
      'Edit: /work/run/ctx/brief.md',
      'Read: /work/run/ws/.env',
    ])
    expect(tools.filter((r) => r.outcome === 'denied').every((r) => r.source === 'policy')).toBe(true)
    expect(byOutcome('completed')).toEqual(['Write: /work/run/ws/SUBMISSION.md', 'Read: /work/run/ctx/brief.md', 'Bash: echo hi && pwd'])
    // Asking for a tool that is not offered is the agent's own failed call, not a policy decision.
    expect(byOutcome('failed')).toEqual(['WebFetch: https://example.com'])
  })
})
