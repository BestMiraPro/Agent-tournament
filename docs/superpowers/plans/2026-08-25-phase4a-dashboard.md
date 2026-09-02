# Agent Tournament — Phase 4a: Live Arena Dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Watch a tournament happen. A browser dashboard that shows every agent working live, ranks them as the judge scores them, and lets the user set the goal and choose to run the next round.

**Architecture:** A Fastify server wraps the existing `TournamentEngine`, driving rounds in the background and broadcasting progress over WebSocket. Engine phase transitions become events; per-agent activity comes from OpenCode's own SSE stream, relayed and re-keyed from `sessionID` to `agentId`. A React + Vite front end renders the agent grid, the leaderboard and the round controls. Nothing in the engine, judge, evolution or sandbox layers changes behaviour — they only gain an event sink.

**Tech Stack:** TypeScript 5, Node 24, Fastify 5, `ws` 8, React 19, Vite 8, Vitest.

**Sources:** `docs/superpowers/specs/2026-08-22-agent-tournament-design.md` (§13 API, §14 UI), `docs/superpowers/specs/2026-08-24-opencode-api-spike.md` (§9 is load-bearing here).

---

## Scope

This is **Phase 4a**: the live arena and the controls that make the tournament interactive. Deferred
to 4b: agent-detail drawer, fitness-over-time chart, lineage tree, model-share chart, strategy diffs.

4a is complete on its own — start a run, watch agents compete, see them ranked, change the goal,
run the next round.

## Verified facts — measured, not assumed

**`GET /event` yields only heartbeats without `?directory=`.** Verified 2026-08-25: an agent ran 10.9
seconds doing real tool work while subscribed without the parameter and produced **zero** message or
session events. With `?directory=<same dir as the session>` the full stream arrives. The failure is
silent — the connection succeeds and frames arrive, so a grid would look healthy and display nothing.

**Wire event types are lowercase-dotted, not the OpenAPI schema names.** The schema is
`EventMessagePartUpdated`; the wire `type` is `message.part.updated`. Coding against schema names
matches nothing.

Observed and usable:

| wire `type` | drives |
|---|---|
| `session.status` (`{type:'busy'}`) / `session.idle` | agent running vs finished |
| `message.part.delta` (`field`, `delta`) | token-by-token streaming |
| `message.part.updated` | tool calls as they happen |
| `file.edited` | agent wrote a file |
| `session.created` | session lifecycle |

Every payload carries `properties.sessionID`.

**Stack versions confirmed available on Node 24.15:** fastify 5.12.1, ws 8.21.3, vite 8.2.2,
@vitejs/plugin-react 6.1.1, react 19.2.8, react-dom 19.2.8. Vite 8 requires Node ≥22.12.

## The mapping problem, and why it needs a hook

Events carry `sessionID`. The dashboard needs `agentId`. `OpenCodeAgentRunner.run` creates its
session internally and returns only an `AgentRunResult`, which arrives **after** the agent finishes —
far too late to label a live stream.

So the runner gains an `onSessionCreated?: (agentId, sessionId) => void` hook, fired the instant the
session exists. The bridge builds its map from that. Adding `sessionId` to `AgentRunResult` instead
would not work: by the time it exists, every event for that agent has already been dropped.

## Two event sources, deliberately kept separate

1. **Engine events** — phase transitions the engine already knows about: round status, agent started
   or finished, scores, budget breach. Emitted by the driver through a sink.
2. **Activity events** — what an agent is *doing* right now, from OpenCode's SSE.

They are separate because the first is authoritative and always available (including in mock mode,
which has no OpenCode at all), while the second is best-effort detail that simply does not exist
when `sandbox: 'mock'`. The grid must render correctly with only the first.

## File structure

| Path | Responsibility |
|---|---|
| `src/engine/events.ts` | `EngineEvent` union and the `EventSink` type. Pure. |
| `src/server/run-manager.ts` | Owns runs, drives rounds in the background, exposes state snapshots. |
| `src/server/event-bridge.ts` | Subscribes to OpenCode SSE per endpoint, re-keys `sessionID`→`agentId`. |
| `src/server/state.ts` | Builds the JSON snapshot the dashboard renders from the database. |
| `src/server/api.ts` | Fastify route definitions. |
| `src/server/ws.ts` | WebSocket fan-out. |
| `src/server/index.ts` | Composition root and `npm run dashboard` entry point. |
| `web/` | Vite React app: grid, leaderboard, controls. |

Modified: `src/engine/driver.ts` (emit events), `src/runtime/opencode/agent-runner.ts` (session hook),
`package.json` (deps and scripts).

---

## Task 1: Engine event types

**Files:**
- Create: `src/engine/events.ts`
- Test: `test/engine/events.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'vitest'
import { collectEvents, type EngineEvent } from '../../src/engine/events.js'

describe('collectEvents', () => {
  test('captures events in order', () => {
    const { sink, events } = collectEvents()
    sink({ type: 'round.status', runId: 'r', roundIdx: 1, status: 'running' })
    sink({ type: 'agent.status', runId: 'r', agentId: 'a', status: 'running' })
    expect(events.map((e) => e.type)).toEqual(['round.status', 'agent.status'])
  })

  test('a sink that throws never breaks the caller', () => {
    const bad = () => {
      throw new Error('subscriber exploded')
    }
    const { safe } = collectEvents()
    expect(() => safe(bad)({ type: 'round.status', runId: 'r', roundIdx: 1, status: 'running' }))
      .not.toThrow()
  })

  test('every event carries a runId', () => {
    const samples: EngineEvent[] = [
      { type: 'round.status', runId: 'r', roundIdx: 1, status: 'running' },
      { type: 'agent.status', runId: 'r', agentId: 'a', status: 'done' },
      { type: 'agent.session', runId: 'r', agentId: 'a', sessionId: 's' },
      { type: 'agent.activity', runId: 'r', agentId: 'a', kind: 'tool', detail: 'bash' },
      { type: 'agent.usage', runId: 'r', agentId: 'a', tokensIn: 1, tokensOut: 2, costUsd: 0 },
      { type: 'round.scored', runId: 'r', roundIdx: 1, scores: [] },
      { type: 'round.complete', runId: 'r', roundIdx: 1, budgetBreach: null },
    ]
    for (const s of samples) expect(s.runId).toBe('r')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/engine/events.test.ts`
Expected: FAIL — cannot resolve `events.js`.

- [ ] **Step 3: Implement**

```typescript
import type { RoundStatus } from '../core/types.js'

export type AgentLiveStatus = 'pending' | 'running' | 'done' | 'failed'

/**
 * Progress the engine itself knows about. Always available, including in mock mode.
 * Distinct from OpenCode activity events, which are best-effort detail and absent
 * entirely when there is no OpenCode server.
 */
export type EngineEvent =
  | { type: 'round.status'; runId: string; roundIdx: number; status: RoundStatus }
  | { type: 'agent.status'; runId: string; agentId: string; status: AgentLiveStatus }
  | { type: 'agent.session'; runId: string; agentId: string; sessionId: string }
  | { type: 'agent.activity'; runId: string; agentId: string; kind: 'tool' | 'text' | 'file'; detail: string }
  | {
      type: 'agent.usage'
      runId: string
      agentId: string
      tokensIn: number
      tokensOut: number
      costUsd: number
    }
  | {
      type: 'round.scored'
      runId: string
      roundIdx: number
      scores: { agentId: string; rank: number; score: number }[]
    }
  | { type: 'round.complete'; runId: string; roundIdx: number; budgetBreach: string | null }

export type EventSink = (event: EngineEvent) => void

export const noopSink: EventSink = () => {}

/** Test helper: a sink that records, plus a wrapper that swallows subscriber errors. */
export function collectEvents(): {
  sink: EventSink
  events: EngineEvent[]
  safe: (inner: EventSink) => EventSink
} {
  const events: EngineEvent[] = []
  return {
    events,
    sink: (e) => {
      events.push(e)
    },
    // A dashboard subscriber must never be able to fail a tournament round.
    safe: (inner) => (e) => {
      try {
        inner(e)
      } catch {
        /* a broken subscriber is not the engine's problem */
      }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/engine/events.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/events.ts test/engine/events.test.ts
git commit -m "feat: add engine event types and sink"
```

---

## Task 2: Driver emits events

**Files:**
- Modify: `src/engine/driver.ts`
- Test: `test/engine/driver.test.ts` (extend)

- [ ] **Step 1: Add the failing tests**

```typescript
describe('driver event emission', () => {
  test('emits round status transitions in lifecycle order', async () => {
    const seen: string[] = []
    const { engine, } = makeMockEngine({
      seed: 1, populationSize: 4,
      onEvent: (e) => { if (e.type === 'round.status') seen.push(e.status) },
    })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(seen).toContain('running')
    expect(seen).toContain('judging')
    expect(seen.at(-1)).toBe('complete')
  })

  test('emits a status per agent, ending in done or failed', async () => {
    const byAgent = new Map<string, string[]>()
    const { engine } = makeMockEngine({
      seed: 1, populationSize: 4,
      onEvent: (e) => {
        if (e.type === 'agent.status') {
          byAgent.set(e.agentId, [...(byAgent.get(e.agentId) ?? []), e.status])
        }
      },
    })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(byAgent.size).toBe(4)
    for (const statuses of byAgent.values()) {
      expect(statuses).toContain('running')
      expect(['done', 'failed']).toContain(statuses.at(-1))
    }
  })

  test('emits scores once judging completes', async () => {
    let scored: { agentId: string; rank: number }[] = []
    const { engine } = makeMockEngine({
      seed: 1, populationSize: 4,
      onEvent: (e) => { if (e.type === 'round.scored') scored = e.scores },
    })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(scored).toHaveLength(4)
    expect(scored.map((s) => s.rank).sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
  })

  test('a subscriber that throws does not fail the round', async () => {
    const { engine, repos } = makeMockEngine({
      seed: 1, populationSize: 3,
      onEvent: () => { throw new Error('subscriber exploded') },
    })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
  })

  test('emits nothing when no sink is provided', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
  })
})
```

- [ ] **Step 2: Add `onEvent` to `makeMockEngine`**

Add `onEvent?: EventSink` to the options in `test/helpers/mock-engine.ts` and pass it through to
`EngineDeps`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/engine/driver.test.ts`
Expected: FAIL — no events emitted.

- [ ] **Step 4: Modify `src/engine/driver.ts`**

Add `onEvent?: EventSink` to `EngineDeps`. Store a guarded emitter on the class so a broken
subscriber can never fail a round:

```typescript
  private emit(event: EngineEvent): void {
    try {
      this.d.onEvent?.(event)
    } catch {
      /* a dashboard subscriber must never break a tournament */
    }
  }
```

Emit at each existing transition:
- wherever `repos.rounds.setStatus(round.id, X)` is called, also `this.emit({type:'round.status', runId, roundIdx, status: X})`
- in the RUN pool worker: `agent.status` `running` before calling the runner, then `done` or `failed` after, based on the result status
- after scores are computed: `round.scored` with `{agentId, rank, score}`
- per agent after its run: `agent.usage` with the token and cost figures already available
- at the end of `runRound`: `round.complete` with the breach reason or null

Do not change any existing behaviour — only add emissions.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS. `test/engine/evolution.integration.test.ts` must still pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/driver.ts test/engine/driver.test.ts test/helpers/mock-engine.ts
git commit -m "feat: emit engine events for round and agent transitions"
```

---

## Task 3: Runner surfaces its session id

**Files:**
- Modify: `src/runtime/opencode/agent-runner.ts`
- Test: `test/runtime/opencode/agent-runner.test.ts` (extend)

- [ ] **Step 1: Add the failing test**

```typescript
describe('session id exposure', () => {
  test('reports the session id as soon as the session is created', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    const seen: { agentId: string; sessionId: string }[] = []
    const runner = new OpenCodeAgentRunner(new FakeClient(okResponse) as never, sb, {
      onSessionCreated: (agentId, sessionId) => seen.push({ agentId, sessionId }),
    })
    await runner.run(h, ctx('s'))
    expect(seen).toEqual([{ agentId: 'a1', sessionId: 'ses_1' }])
  })

  test('a throwing hook does not fail the run', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    const runner = new OpenCodeAgentRunner(new FakeClient(okResponse) as never, sb, {
      onSessionCreated: () => { throw new Error('hook exploded') },
    })
    const res = await runner.run(h, ctx('s'))
    expect(res.status).toBe('ok')
  })

  test('works without the hook', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    const res = await new OpenCodeAgentRunner(new FakeClient(okResponse) as never, sb).run(h, ctx('s'))
    expect(res.status).toBe('ok')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/runtime/opencode/agent-runner.test.ts`
Expected: FAIL — the constructor takes no third argument.

- [ ] **Step 3: Modify the runner**

Add an options parameter:

```typescript
export interface AgentRunnerOptions {
  /**
   * Fired the instant a session exists, so a live dashboard can map OpenCode's
   * sessionID-keyed events onto agents. It cannot wait for AgentRunResult: by then
   * every event for this agent has already been emitted and dropped.
   */
  onSessionCreated?: (agentId: string, sessionId: string) => void
}
```

Take it as an optional third constructor argument. Immediately after `createSession` succeeds, call
it inside a `try/catch` that swallows subscriber errors.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/runtime/opencode/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/opencode/agent-runner.ts test/runtime/opencode/agent-runner.test.ts
git commit -m "feat: surface the agent session id for live event mapping"
```

---

## Task 4: State snapshot

The dashboard needs a full picture on connect, before any live event arrives.

**Files:**
- Create: `src/server/state.ts`
- Test: `test/server/state.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { buildRunSnapshot } from '../../src/server/state.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'

const setup = () => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const run = repos.runs.create({ name: 'demo', config: DEFAULT_CONFIG, seedDir: null })
  const a1 = repos.agents.create({ runId: run.id, label: 'competitor-01', parentAgentId: null, bornRound: 1 })
  const a2 = repos.agents.create({ runId: run.id, label: 'competitor-02', parentAgentId: null, bornRound: 1 })
  for (const a of [a1, a2]) {
    repos.genomes.create({
      agentId: a.id, roundIdx: 1, strategyMd: `strategy for ${a.label}`, notesMd: '',
      modelId: 'opencode/big-pickle', temperature: 0.7, parentGenomeId: null, origin: 'seed',
    })
  }
  return { repos, run, a1, a2 }
}

describe('buildRunSnapshot', () => {
  test('returns null for an unknown run', () => {
    const { repos } = setup()
    expect(buildRunSnapshot(repos, 'nope')).toBeNull()
  })

  test('includes the run name and active agents', () => {
    const { repos, run } = setup()
    const s = buildRunSnapshot(repos, run.id)!
    expect(s.name).toBe('demo')
    expect(s.agents).toHaveLength(2)
    expect(s.agents.map((a) => a.label).sort()).toEqual(['competitor-01', 'competitor-02'])
  })

  test('reports each agent model from its current genome', () => {
    const { repos, run } = setup()
    const s = buildRunSnapshot(repos, run.id)!
    expect(s.agents.every((a) => a.modelId === 'opencode/big-pickle')).toBe(true)
  })

  test('reports round zero before any round has run', () => {
    const { repos, run } = setup()
    expect(buildRunSnapshot(repos, run.id)!.lastRoundIdx).toBe(0)
  })

  test('includes scores from the latest completed round', () => {
    const { repos, run, a1, a2 } = setup()
    const round = repos.rounds.create({ runId: run.id, idx: 1, goalMd: 'g' })
    repos.scores.insertMany(round.id, [
      { roundId: round.id, agentId: a2.id, rank: 1, score: 90, rationaleMd: 'strong', band: 'elite' },
      { roundId: round.id, agentId: a1.id, rank: 2, score: 40, rationaleMd: 'weak', band: 'bottom' },
    ])
    const s = buildRunSnapshot(repos, run.id)!
    expect(s.lastRoundIdx).toBe(1)
    expect(s.scores[0]!.rank).toBe(1)
    expect(s.scores[0]!.agentId).toBe(a2.id)
  })

  test('is JSON-serializable', () => {
    const { repos, run } = setup()
    expect(() => JSON.stringify(buildRunSnapshot(repos, run.id))).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server/state.test.ts`
Expected: FAIL — cannot resolve `state.js`.

- [ ] **Step 3: Implement**

```typescript
import type { Repos } from '../db/repos.js'

export interface SnapshotAgent {
  agentId: string
  label: string
  modelId: string
  temperature: number
  strategyMd: string
  bornRound: number
  parentAgentId: string | null
}

export interface SnapshotScore {
  agentId: string
  rank: number
  score: number
  band: string | null
  rationaleMd: string
}

export interface RunSnapshot {
  runId: string
  name: string
  lastRoundIdx: number
  goalMd: string | null
  agents: SnapshotAgent[]
  scores: SnapshotScore[]
}

/** The full picture the dashboard renders on connect, before any live event arrives. */
export function buildRunSnapshot(repos: Repos, runId: string): RunSnapshot | null {
  const run = repos.runs.get(runId)
  if (!run) return null

  const lastRoundIdx = repos.rounds.lastIdx(runId)
  const agents = repos.agents.listActive(runId)

  const snapshotAgents: SnapshotAgent[] = agents.map((a) => {
    // A newly bred agent has a genome for the NEXT round, not the last completed one.
    const genome =
      repos.genomes.forRound(a.id, lastRoundIdx + 1) ??
      repos.genomes.forRound(a.id, lastRoundIdx)
    return {
      agentId: a.id,
      label: a.label,
      modelId: genome?.modelId ?? 'unknown',
      temperature: genome?.temperature ?? 0,
      strategyMd: genome?.strategyMd ?? '',
      bornRound: a.bornRound,
      parentAgentId: a.parentAgentId,
    }
  })

  let scores: SnapshotScore[] = []
  let goalMd: string | null = null
  if (lastRoundIdx > 0) {
    const rounds = repos.rounds.listForRun?.(runId) ?? []
    const last = rounds.find((r) => r.idx === lastRoundIdx)
    if (last) {
      goalMd = last.goalMd
      scores = repos.scores.forRound(last.id).map((s) => ({
        agentId: s.agentId,
        rank: s.rank,
        score: s.score,
        band: s.band,
        rationaleMd: s.rationaleMd,
      }))
    }
  }

  return { runId, name: run.name, lastRoundIdx, goalMd, agents: snapshotAgents, scores }
}
```

If `repos.rounds` has no `listForRun`, add one returning all rounds for a run ordered by `idx`,
mirroring the existing repo style, plus a test for it in `test/db/repos.test.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server/state.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/state.ts test/server/state.test.ts src/db/repos.ts test/db/repos.test.ts
git commit -m "feat: build a run snapshot for the dashboard"
```

---

## Task 5: Run manager

**Files:**
- Create: `src/server/run-manager.ts`
- Test: `test/server/run-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test, vi } from 'vitest'
import { RunManager } from '../../src/server/run-manager.js'
import type { EngineEvent } from '../../src/engine/events.js'

const fakeEngine = (opts: { fail?: boolean; delayMs?: number } = {}) => {
  const calls: { runId: string; goalMd: string }[] = []
  return {
    calls,
    engine: {
      createRun: (name: string) => ({ id: `run-${name}` }),
      runRound: async (runId: string, input: { goalMd: string }) => {
        calls.push({ runId, goalMd: input.goalMd })
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
        if (opts.fail) throw new Error('round exploded')
        return { roundId: 'rd', roundIdx: calls.length, metaDigest: '', budgetBreach: null }
      },
      dispose: vi.fn(async () => {}),
    },
  }
}

describe('RunManager', () => {
  test('startRound returns immediately and runs in the background', async () => {
    const { engine, calls } = fakeEngine({ delayMs: 50 })
    const m = new RunManager(engine as never, () => {})
    const t0 = Date.now()
    m.startRound('r1', { goalMd: 'g', criteriaMd: null })
    expect(Date.now() - t0).toBeLessThan(30)
    await m.waitForIdle('r1')
    expect(calls).toHaveLength(1)
  })

  test('reports a round as busy while it runs', async () => {
    const { engine } = fakeEngine({ delayMs: 50 })
    const m = new RunManager(engine as never, () => {})
    m.startRound('r1', { goalMd: 'g', criteriaMd: null })
    expect(m.isBusy('r1')).toBe(true)
    await m.waitForIdle('r1')
    expect(m.isBusy('r1')).toBe(false)
  })

  test('refuses to start a second round while one is running', async () => {
    const { engine, calls } = fakeEngine({ delayMs: 50 })
    const m = new RunManager(engine as never, () => {})
    m.startRound('r1', { goalMd: 'g', criteriaMd: null })
    expect(() => m.startRound('r1', { goalMd: 'g2', criteriaMd: null })).toThrow(/already running/i)
    await m.waitForIdle('r1')
    expect(calls).toHaveLength(1)
  })

  test('allows concurrent rounds for different runs', async () => {
    const { engine, calls } = fakeEngine({ delayMs: 30 })
    const m = new RunManager(engine as never, () => {})
    m.startRound('r1', { goalMd: 'g', criteriaMd: null })
    m.startRound('r2', { goalMd: 'g', criteriaMd: null })
    await Promise.all([m.waitForIdle('r1'), m.waitForIdle('r2')])
    expect(calls).toHaveLength(2)
  })

  test('a failing round emits an error event and leaves the run idle', async () => {
    const seen: EngineEvent[] = []
    const { engine } = fakeEngine({ fail: true })
    const m = new RunManager(engine as never, (e) => seen.push(e))
    m.startRound('r1', { goalMd: 'g', criteriaMd: null })
    await m.waitForIdle('r1')
    expect(m.isBusy('r1')).toBe(false)
    expect(seen.some((e) => e.type === 'round.complete')).toBe(true)
  })

  test('lastError records why a round failed', async () => {
    const { engine } = fakeEngine({ fail: true })
    const m = new RunManager(engine as never, () => {})
    m.startRound('r1', { goalMd: 'g', criteriaMd: null })
    await m.waitForIdle('r1')
    expect(m.lastError('r1')).toMatch(/exploded/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server/run-manager.test.ts`
Expected: FAIL — cannot resolve `run-manager.js`.

- [ ] **Step 3: Implement**

```typescript
import type { EventSink } from '../engine/events.js'
import type { TournamentEngine } from '../engine/driver.js'

export interface StartRoundInput {
  goalMd: string
  criteriaMd: string | null
}

/**
 * Drives rounds in the background so an HTTP request never blocks on a tournament
 * that takes minutes. Progress reaches the browser through events, not the response.
 */
export class RunManager {
  private inFlight = new Map<string, Promise<void>>()
  private errors = new Map<string, string>()

  constructor(private engine: TournamentEngine, private emit: EventSink) {}

  isBusy(runId: string): boolean {
    return this.inFlight.has(runId)
  }

  lastError(runId: string): string | null {
    return this.errors.get(runId) ?? null
  }

  startRound(runId: string, input: StartRoundInput): void {
    if (this.inFlight.has(runId)) {
      throw new Error(`a round is already running for run ${runId}`)
    }
    this.errors.delete(runId)

    const task = (async () => {
      try {
        await this.engine.runRound(runId, input)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        this.errors.set(runId, message)
        // The round driver already marks the round failed in the database; this makes
        // the failure visible to a dashboard that is only listening to events.
        this.emit({ type: 'round.complete', runId, roundIdx: -1, budgetBreach: message })
      } finally {
        this.inFlight.delete(runId)
      }
    })()

    this.inFlight.set(runId, task)
  }

  /** Resolves once no round is running for this run. */
  async waitForIdle(runId: string): Promise<void> {
    const task = this.inFlight.get(runId)
    if (task) await task
  }

  async disposeAll(): Promise<void> {
    for (const [runId, task] of this.inFlight) {
      await task.catch(() => {})
      await this.engine.dispose(runId).catch(() => {})
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server/run-manager.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/run-manager.ts test/server/run-manager.test.ts
git commit -m "feat: drive rounds in the background via a run manager"
```

---

## Task 6: OpenCode event bridge

**Files:**
- Create: `src/server/event-bridge.ts`
- Test: `test/server/event-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'vitest'
import { parseSseFrames, mapOpenCodeEvent } from '../../src/server/event-bridge.js'

describe('parseSseFrames', () => {
  test('extracts complete data frames and keeps the remainder', () => {
    const r = parseSseFrames('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"')
    expect(r.frames).toEqual(['{"a":1}', '{"b":2}'])
    expect(r.rest).toBe('data: {"c"')
  })

  test('ignores non-data lines', () => {
    expect(parseSseFrames(': keepalive\n\ndata: {"a":1}\n\n').frames).toEqual(['{"a":1}'])
  })

  test('returns nothing for a partial first frame', () => {
    const r = parseSseFrames('data: {"partial"')
    expect(r.frames).toEqual([])
    expect(r.rest).toBe('data: {"partial"')
  })
})

describe('mapOpenCodeEvent', () => {
  const lookup = (sessionId: string) => (sessionId === 'ses_1' ? 'agent-1' : null)

  test('maps a tool part to an activity event', () => {
    const e = mapOpenCodeEvent(
      { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { type: 'tool', tool: 'bash' } } },
      'run-1', lookup,
    )
    expect(e).toEqual({ type: 'agent.activity', runId: 'run-1', agentId: 'agent-1', kind: 'tool', detail: 'bash' })
  })

  test('maps a file edit to an activity event', () => {
    const e = mapOpenCodeEvent(
      { type: 'file.edited', properties: { sessionID: 'ses_1', file: 'SUBMISSION.md' } },
      'run-1', lookup,
    )
    expect(e?.kind).toBe('file')
  })

  test('returns null for an unmapped session', () => {
    expect(mapOpenCodeEvent(
      { type: 'file.edited', properties: { sessionID: 'ses_unknown' } }, 'run-1', lookup,
    )).toBeNull()
  })

  test('returns null for transport noise', () => {
    expect(mapOpenCodeEvent({ type: 'server.heartbeat', properties: {} }, 'run-1', lookup)).toBeNull()
  })

  test('returns null for an event with no session id', () => {
    expect(mapOpenCodeEvent({ type: 'file.edited', properties: {} }, 'run-1', lookup)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server/event-bridge.test.ts`
Expected: FAIL — cannot resolve `event-bridge.js`.

- [ ] **Step 3: Implement**

```typescript
import type { EngineEvent, EventSink } from '../engine/events.js'

export function parseSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = []
  const parts = buffer.split('\n\n')
  const rest = parts.pop() ?? ''
  for (const block of parts) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) frames.push(line.slice(5).trim())
    }
  }
  return { frames, rest }
}

interface RawEvent {
  type?: string
  properties?: Record<string, unknown>
}

/**
 * Re-keys an OpenCode event from sessionID onto an agent.
 *
 * Wire types are lowercase-dotted (`message.part.updated`), NOT the OpenAPI schema
 * names (`EventMessagePartUpdated`). Matching schema names matches nothing.
 */
export function mapOpenCodeEvent(
  raw: RawEvent,
  runId: string,
  lookupAgent: (sessionId: string) => string | null,
): Extract<EngineEvent, { type: 'agent.activity' }> | null {
  const sessionId = raw.properties?.sessionID
  if (typeof sessionId !== 'string') return null
  const agentId = lookupAgent(sessionId)
  if (!agentId) return null

  const activity = (kind: 'tool' | 'text' | 'file', detail: string) =>
    ({ type: 'agent.activity' as const, runId, agentId, kind, detail })

  switch (raw.type) {
    case 'message.part.updated': {
      const part = raw.properties?.part as { type?: string; tool?: string; text?: string } | undefined
      if (part?.type === 'tool') return activity('tool', part.tool ?? 'tool')
      if (part?.type === 'text') return activity('text', (part.text ?? '').slice(0, 200))
      return null
    }
    case 'file.edited':
      return activity('file', String(raw.properties?.file ?? 'file'))
    default:
      return null
  }
}

export interface BridgeHandle {
  stop(): void
}

/**
 * Subscribes to one OpenCode server's event stream and relays agent activity.
 *
 * `directory` is REQUIRED. Verified: subscribing without it yields only
 * `server.connected` and `server.heartbeat` — the connection succeeds and frames
 * arrive, so the failure is silent and a grid would show nothing forever.
 */
export function startEventBridge(opts: {
  baseUrl: string
  directory: string
  runId: string
  lookupAgent: (sessionId: string) => string | null
  emit: EventSink
  onError?: (e: Error) => void
}): BridgeHandle {
  const controller = new AbortController()

  void (async () => {
    try {
      const url = `${opts.baseUrl}/event?directory=${encodeURIComponent(opts.directory)}`
      const res = await fetch(url, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      })
      if (!res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        const { frames, rest } = parseSseFrames(buffer)
        buffer = rest
        for (const frame of frames) {
          let raw: RawEvent
          try {
            raw = JSON.parse(frame)
          } catch {
            continue
          }
          const mapped = mapOpenCodeEvent(raw, opts.runId, opts.lookupAgent)
          if (mapped) opts.emit(mapped)
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        opts.onError?.(e instanceof Error ? e : new Error(String(e)))
      }
    }
  })()

  return { stop: () => controller.abort() }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server/event-bridge.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/event-bridge.ts test/server/event-bridge.test.ts
git commit -m "feat: relay OpenCode activity events onto agents"
```

---

## Task 7: Install the server and web dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install**

```bash
npm install fastify ws
npm install -D @types/ws vite @vitejs/plugin-react react react-dom @types/react @types/react-dom
```

- [ ] **Step 2: Add scripts to `package.json`**

```json
    "dashboard": "tsx src/server/index.ts",
    "web:dev": "vite",
    "web:build": "vite build"
```

- [ ] **Step 3: Verify nothing broke**

Run: `npm test && npm run typecheck`
Expected: all existing tests still pass; typecheck exits 0.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add dashboard dependencies"
```

---

## Task 8: REST API and WebSocket fan-out

**Files:**
- Create: `src/server/ws.ts`, `src/server/api.ts`
- Test: `test/server/api.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'vitest'
import { buildApi } from '../../src/server/api.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'

const setup = () => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const started: { runId: string; goalMd: string }[] = []
  const app = buildApi({
    repos,
    manager: {
      isBusy: () => false,
      lastError: () => null,
      startRound: (runId: string, input: { goalMd: string }) => { started.push({ runId, goalMd: input.goalMd }) },
    } as never,
    createRun: (name: string, goal: string) => {
      const r = repos.runs.create({ name, config: DEFAULT_CONFIG, seedDir: null })
      void goal
      return r.id
    },
  })
  return { app, repos, started }
}

describe('API', () => {
  test('POST /api/runs creates a run and returns its id', async () => {
    const { app } = setup()
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).runId).toBeTruthy()
  })

  test('GET /api/runs lists runs', async () => {
    const { app } = setup()
    await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })
    const res = await app.inject({ method: 'GET', url: '/api/runs' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).runs.length).toBeGreaterThan(0)
  })

  test('GET /api/runs/:id returns a snapshot', async () => {
    const { app } = setup()
    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })).body,
    )
    const res = await app.inject({ method: 'GET', url: `/api/runs/${created.runId}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).name).toBe('demo')
  })

  test('GET /api/runs/:id is 404 for an unknown run', async () => {
    const { app } = setup()
    expect((await app.inject({ method: 'GET', url: '/api/runs/nope' })).statusCode).toBe(404)
  })

  test('POST /api/runs/:id/rounds starts a round and returns 202', async () => {
    const { app, started } = setup()
    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })).body,
    )
    const res = await app.inject({
      method: 'POST', url: `/api/runs/${created.runId}/rounds`, payload: { goalMd: 'new goal' },
    })
    expect(res.statusCode).toBe(202)
    expect(started).toHaveLength(1)
    expect(started[0]!.goalMd).toBe('new goal')
  })

  test('starting a round requires a goal', async () => {
    const { app } = setup()
    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })).body,
    )
    const res = await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/rounds`, payload: {} })
    expect(res.statusCode).toBe(400)
  })

  test('rejects starting a round on an unknown run', async () => {
    const { app } = setup()
    const res = await app.inject({ method: 'POST', url: '/api/runs/nope/rounds', payload: { goalMd: 'g' } })
    expect(res.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server/api.test.ts`
Expected: FAIL — cannot resolve `api.js`.

- [ ] **Step 3: Implement `src/server/ws.ts`**

```typescript
import { WebSocketServer, type WebSocket } from 'ws'
import type { EngineEvent } from '../engine/events.js'

/** Fans engine events out to every connected dashboard. */
export class EventBroadcaster {
  private clients = new Set<WebSocket>()

  attach(wss: WebSocketServer): void {
    wss.on('connection', (socket) => {
      this.clients.add(socket)
      socket.on('close', () => this.clients.delete(socket))
      socket.on('error', () => this.clients.delete(socket))
    })
  }

  broadcast(event: EngineEvent): void {
    const payload = JSON.stringify(event)
    for (const socket of this.clients) {
      // readyState 1 === OPEN. A dead socket must never throw into the engine.
      if (socket.readyState === 1) {
        try {
          socket.send(payload)
        } catch {
          this.clients.delete(socket)
        }
      }
    }
  }

  get size(): number {
    return this.clients.size
  }
}
```

- [ ] **Step 4: Implement `src/server/api.ts`**

```typescript
import Fastify, { type FastifyInstance } from 'fastify'
import type { Repos } from '../db/repos.js'
import type { RunManager } from './run-manager.js'
import { buildRunSnapshot } from './state.js'

export interface ApiDeps {
  repos: Repos
  manager: RunManager
  createRun: (name: string, goal: string) => string
}

export function buildApi(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false })

  app.post('/api/runs', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; goal?: string }
    if (!body.name || !body.goal) {
      return reply.code(400).send({ error: 'name and goal are required' })
    }
    const runId = deps.createRun(body.name, body.goal)
    return reply.code(201).send({ runId })
  })

  app.get('/api/runs', async () => ({
    runs: deps.repos.runs.list?.() ?? [],
  }))

  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const snapshot = buildRunSnapshot(deps.repos, id)
    if (!snapshot) return reply.code(404).send({ error: 'no such run' })
    return {
      ...snapshot,
      busy: deps.manager.isBusy(id),
      lastError: deps.manager.lastError(id),
    }
  })

  app.post('/api/runs/:id/rounds', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { goalMd?: string; criteriaMd?: string | null }
    if (!deps.repos.runs.get(id)) return reply.code(404).send({ error: 'no such run' })
    if (!body.goalMd) return reply.code(400).send({ error: 'goalMd is required' })
    try {
      deps.manager.startRound(id, { goalMd: body.goalMd, criteriaMd: body.criteriaMd ?? null })
    } catch (e) {
      return reply.code(409).send({ error: e instanceof Error ? e.message : String(e) })
    }
    return reply.code(202).send({ started: true })
  })

  return app
}
```

If `repos.runs` has no `list`, add one returning `{id, name, createdAt}` ordered newest first, plus a
test in `test/db/repos.test.ts`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/server/api.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/api.ts src/server/ws.ts test/server/api.test.ts src/db/repos.ts test/db/repos.test.ts
git commit -m "feat: add dashboard REST API and websocket fan-out"
```

---

## Task 9: Server composition root

**Files:**
- Create: `src/server/index.ts`

- [ ] **Step 1: Implement**

```typescript
import { WebSocketServer } from 'ws'
import { parseArgs } from 'node:util'
import { DEFAULT_CONFIG, type RunConfig } from '../core/types.js'
import { openDb } from '../db/open.js'
import { makeRepos } from '../db/repos.js'
import { TournamentEngine } from '../engine/driver.js'
import type { EngineEvent } from '../engine/events.js'
import { Judge } from '../judge/judge.js'
import { Reflector } from '../evolution/reflect.js'
import { MockAgentRunner } from '../runtime/agent-runner.js'
import { MockProvider } from '../runtime/mock-provider.js'
import { MockSandbox } from '../runtime/mock-sandbox.js'
import { buildApi } from './api.js'
import { RunManager } from './run-manager.js'
import { EventBroadcaster } from './ws.js'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4300' },
    db: { type: 'string', default: ':memory:' },
    population: { type: 'string', default: '8' },
  },
})

const port = Number(values.port)
const db = openDb(values.db!)
const repos = makeRepos(db)

const config: RunConfig = {
  ...DEFAULT_CONFIG,
  populationSize: Number(values.population),
  sandbox: 'mock',
  roster: [{ modelId: 'mock/model', count: Number(values.population), temperature: 0.7 }],
}

const broadcaster = new EventBroadcaster()
const emit = (e: EngineEvent) => broadcaster.broadcast(e)

const provider = new MockProvider(42)
const sandbox = new MockSandbox()
const engine = new TournamentEngine({
  repos,
  config,
  sandbox,
  runner: new MockAgentRunner(sandbox, 42),
  judge: new Judge(provider, config.judge, 42),
  reflector: new Reflector(provider, config.reflect, config.roster.map((r) => r.modelId)),
  seedStrategy: (i) => `attempt the goal, variant ${i}`,
  onEvent: emit,
})

const manager = new RunManager(engine, emit)
const app = buildApi({
  repos,
  manager,
  createRun: (name) => engine.createRun(name, '').id,
})

const server = app.server
const wss = new WebSocketServer({ server, path: '/ws' })
broadcaster.attach(wss)

await app.listen({ port, host: '127.0.0.1' })
console.log(`dashboard API on http://127.0.0.1:${port}`)
console.log(`websocket on ws://127.0.0.1:${port}/ws`)
console.log(`run the UI with: npm run web:dev`)

const shutdown = async () => {
  await manager.disposeAll().catch(() => {})
  await app.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
```

This wires **mock mode** deliberately: the dashboard must be developable and demonstrable without
spending money or needing Docker. Real and Docker modes arrive in Phase 4b alongside the run-setup
screen that configures them.

- [ ] **Step 2: Verify it starts**

Run: `npm run dashboard -- --port 4300`
Expected: prints the three lines above and stays running. Stop it with Ctrl-C.

Then in another shell:
```bash
curl -s -X POST http://127.0.0.1:4300/api/runs -H 'content-type: application/json' -d '{"name":"demo","goal":"write a haiku"}'
```
Expected: `{"runId":"..."}`.

- [ ] **Step 3: Commit**

```bash
git add src/server/index.ts
git commit -m "feat: add the dashboard server entry point"
```

---

## Task 10: Vite React scaffold

**Files:**
- Create: `vite.config.ts`, `index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api.ts`

- [ ] **Step 1: Create `vite.config.ts`**

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4301,
    // The API and websocket live on the dashboard server; proxying keeps the browser
    // on one origin so there is no CORS configuration to get wrong.
    proxy: {
      '/api': 'http://127.0.0.1:4300',
      '/ws': { target: 'ws://127.0.0.1:4300', ws: true },
    },
  },
})
```

- [ ] **Step 2: Create `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agent Tournament</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/web/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `web/src/api.ts`**

```typescript
export interface SnapshotAgent {
  agentId: string
  label: string
  modelId: string
  temperature: number
  strategyMd: string
  bornRound: number
  parentAgentId: string | null
}

export interface SnapshotScore {
  agentId: string
  rank: number
  score: number
  band: string | null
  rationaleMd: string
}

export interface RunSnapshot {
  runId: string
  name: string
  lastRoundIdx: number
  goalMd: string | null
  agents: SnapshotAgent[]
  scores: SnapshotScore[]
  busy: boolean
  lastError: string | null
}

const json = async (res: Response) => {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

export const createRun = (name: string, goal: string): Promise<{ runId: string }> =>
  fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, goal }),
  }).then(json)

export const getRun = (runId: string): Promise<RunSnapshot> =>
  fetch(`/api/runs/${runId}`).then(json)

export const startRound = (runId: string, goalMd: string): Promise<unknown> =>
  fetch(`/api/runs/${runId}/rounds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goalMd }),
  }).then(json)
```

- [ ] **Step 4: Create `web/src/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 5: Create a placeholder `web/src/App.tsx`**

```tsx
export function App() {
  return <h1>Agent Tournament</h1>
}
```

- [ ] **Step 6: Verify the dev server starts**

Run: `npm run web:dev`
Expected: Vite serves on http://127.0.0.1:4301 and the page shows the heading. Stop with Ctrl-C.

- [ ] **Step 7: Commit**

```bash
git add vite.config.ts index.html web/
git commit -m "feat: scaffold the Vite React dashboard"
```

---

## Task 11: Live event hook

**Files:**
- Create: `web/src/useLiveRun.ts`
- Test: `test/web/live-run.test.ts`

- [ ] **Step 1: Write the failing test**

The reducer is pure and testable without a browser; the socket is not. Test the reducer.

```typescript
import { describe, expect, test } from 'vitest'
import { liveReducer, initialLiveState } from '../../web/src/useLiveRun.js'

describe('liveReducer', () => {
  test('marks an agent running', () => {
    const s = liveReducer(initialLiveState, { type: 'agent.status', runId: 'r', agentId: 'a', status: 'running' })
    expect(s.agents['a']?.status).toBe('running')
  })

  test('records the latest activity for an agent', () => {
    let s = liveReducer(initialLiveState, { type: 'agent.activity', runId: 'r', agentId: 'a', kind: 'tool', detail: 'bash' })
    s = liveReducer(s, { type: 'agent.activity', runId: 'r', agentId: 'a', kind: 'tool', detail: 'read' })
    expect(s.agents['a']?.activity).toBe('read')
  })

  test('accumulates usage', () => {
    let s = liveReducer(initialLiveState, { type: 'agent.usage', runId: 'r', agentId: 'a', tokensIn: 10, tokensOut: 5, costUsd: 0.1 })
    s = liveReducer(s, { type: 'agent.usage', runId: 'r', agentId: 'a', tokensIn: 20, tokensOut: 5, costUsd: 0.2 })
    expect(s.agents['a']?.tokensIn).toBe(30)
    expect(s.agents['a']?.costUsd).toBeCloseTo(0.3)
  })

  test('stores scores by rank', () => {
    const s = liveReducer(initialLiveState, {
      type: 'round.scored', runId: 'r', roundIdx: 1,
      scores: [{ agentId: 'b', rank: 1, score: 90 }, { agentId: 'a', rank: 2, score: 40 }],
    })
    expect(s.scores[0]!.agentId).toBe('b')
  })

  test('tracks round status', () => {
    const s = liveReducer(initialLiveState, { type: 'round.status', runId: 'r', roundIdx: 1, status: 'judging' })
    expect(s.roundStatus).toBe('judging')
  })

  test('round.complete clears the busy flag and records a breach', () => {
    const s = liveReducer(initialLiveState, { type: 'round.complete', runId: 'r', roundIdx: 1, budgetBreach: 'over budget' })
    expect(s.busy).toBe(false)
    expect(s.lastBreach).toBe('over budget')
  })

  test('a new round resets agent activity but keeps scores until rescored', () => {
    let s = liveReducer(initialLiveState, { type: 'agent.status', runId: 'r', agentId: 'a', status: 'done' })
    s = liveReducer(s, { type: 'round.status', runId: 'r', roundIdx: 2, status: 'preparing' })
    expect(s.agents['a']?.status).toBe('pending')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/web/live-run.test.ts`
Expected: FAIL — cannot resolve `useLiveRun.js`.

- [ ] **Step 3: Implement**

```typescript
import { useEffect, useReducer } from 'react'
import type { RunSnapshot } from './api.js'

export interface LiveAgent {
  status: 'pending' | 'running' | 'done' | 'failed'
  activity: string
  tokensIn: number
  tokensOut: number
  costUsd: number
}

export interface LiveState {
  agents: Record<string, LiveAgent>
  scores: { agentId: string; rank: number; score: number }[]
  roundStatus: string
  roundIdx: number
  busy: boolean
  lastBreach: string | null
}

export const initialLiveState: LiveState = {
  agents: {},
  scores: [],
  roundStatus: 'idle',
  roundIdx: 0,
  busy: false,
  lastBreach: null,
}

const blank: LiveAgent = { status: 'pending', activity: '', tokensIn: 0, tokensOut: 0, costUsd: 0 }

/** Pure so it can be tested without a browser or a socket. */
export function liveReducer(state: LiveState, event: { type: string } & Record<string, unknown>): LiveState {
  const agentId = event.agentId as string | undefined
  const current = agentId ? (state.agents[agentId] ?? blank) : blank

  switch (event.type) {
    case 'round.status': {
      const status = event.status as string
      // A new round starts every agent fresh; stale "done" badges would misreport progress.
      const agents =
        status === 'preparing'
          ? Object.fromEntries(Object.keys(state.agents).map((id) => [id, { ...blank }]))
          : state.agents
      return { ...state, roundStatus: status, roundIdx: event.roundIdx as number, busy: true, agents }
    }
    case 'agent.status':
      if (!agentId) return state
      return {
        ...state,
        agents: { ...state.agents, [agentId]: { ...current, status: event.status as LiveAgent['status'] } },
      }
    case 'agent.activity':
      if (!agentId) return state
      return {
        ...state,
        agents: { ...state.agents, [agentId]: { ...current, activity: event.detail as string } },
      }
    case 'agent.usage':
      if (!agentId) return state
      return {
        ...state,
        agents: {
          ...state.agents,
          [agentId]: {
            ...current,
            tokensIn: current.tokensIn + (event.tokensIn as number),
            tokensOut: current.tokensOut + (event.tokensOut as number),
            costUsd: current.costUsd + (event.costUsd as number),
          },
        },
      }
    case 'round.scored':
      return {
        ...state,
        scores: [...(event.scores as LiveState['scores'])].sort((a, b) => a.rank - b.rank),
      }
    case 'round.complete':
      return { ...state, busy: false, lastBreach: (event.budgetBreach as string | null) ?? null }
    default:
      return state
  }
}

export function useLiveRun(snapshot: RunSnapshot | null): LiveState {
  const [state, dispatch] = useReducer(liveReducer, initialLiveState)

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${proto}://${location.host}/ws`)
    socket.onmessage = (m) => {
      try {
        dispatch(JSON.parse(m.data as string))
      } catch {
        /* ignore malformed frames rather than killing the stream */
      }
    }
    return () => socket.close()
  }, [])

  void snapshot
  return state
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/web/live-run.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/useLiveRun.ts test/web/live-run.test.ts
git commit -m "feat: add the live run reducer and websocket hook"
```

---

## Task 12: Arena UI

**Files:**
- Create: `web/src/components/AgentGrid.tsx`, `web/src/components/Leaderboard.tsx`, `web/src/components/RoundControls.tsx`, `web/src/styles.css`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Create `web/src/components/AgentGrid.tsx`**

```tsx
import type { SnapshotAgent } from '../api.js'
import type { LiveState } from '../useLiveRun.js'

const STATUS_LABEL: Record<string, string> = {
  pending: 'waiting',
  running: 'working',
  done: 'done',
  failed: 'failed',
}

export function AgentGrid({ agents, live }: { agents: SnapshotAgent[]; live: LiveState }) {
  const rankOf = new Map(live.scores.map((s) => [s.agentId, s.rank]))

  return (
    <div className="grid">
      {agents.map((a) => {
        const l = live.agents[a.agentId]
        const status = l?.status ?? 'pending'
        const rank = rankOf.get(a.agentId)
        return (
          <div key={a.agentId} className={`cell cell--${status}`}>
            <div className="cell__head">
              <span className="cell__label">{a.label}</span>
              {rank !== undefined && <span className="cell__rank">#{rank}</span>}
            </div>
            <div className="cell__model" title={a.modelId}>{a.modelId}</div>
            <div className="cell__status">{STATUS_LABEL[status] ?? status}</div>
            <div className="cell__activity">{l?.activity || ' '}</div>
            <div className="cell__usage">
              {l ? `${l.tokensIn + l.tokensOut} tok` : ' '}
            </div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Create `web/src/components/Leaderboard.tsx`**

```tsx
import type { SnapshotAgent } from '../api.js'
import type { LiveState } from '../useLiveRun.js'

export function Leaderboard({ agents, live }: { agents: SnapshotAgent[]; live: LiveState }) {
  const labelOf = new Map(agents.map((a) => [a.agentId, a.label]))
  if (live.scores.length === 0) return <p className="muted">No scores yet.</p>

  return (
    <table className="leaderboard">
      <thead>
        <tr><th>#</th><th>Agent</th><th>Score</th></tr>
      </thead>
      <tbody>
        {live.scores.map((s) => (
          <tr key={s.agentId}>
            <td>{s.rank}</td>
            <td>{labelOf.get(s.agentId) ?? s.agentId.slice(0, 8)}</td>
            <td>{s.score.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 3: Create `web/src/components/RoundControls.tsx`**

```tsx
import { useState } from 'react'

export function RoundControls({
  goal, busy, roundIdx, onRun,
}: {
  goal: string
  busy: boolean
  roundIdx: number
  onRun: (goalMd: string) => void
}) {
  const [text, setText] = useState(goal)

  return (
    <div className="controls">
      <label htmlFor="goal">Goal for round {roundIdx + 1}</label>
      <textarea
        id="goal"
        value={text}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />
      <button onClick={() => onRun(text)} disabled={busy || text.trim().length === 0}>
        {busy ? 'Round in progress…' : `Run round ${roundIdx + 1}`}
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Create `web/src/styles.css`**

```css
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; padding: 1.5rem; }
h1 { font-size: 1.25rem; margin: 0 0 1rem; }
.layout { display: grid; grid-template-columns: 1fr 22rem; gap: 1.5rem; align-items: start; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: .5rem; }
.cell { border: 1px solid #8883; border-radius: .5rem; padding: .5rem .6rem; font-size: .8rem; }
.cell--running { border-color: #3b82f6; background: #3b82f610; }
.cell--done    { border-color: #22c55e; background: #22c55e10; }
.cell--failed  { border-color: #ef4444; background: #ef444410; }
.cell__head { display: flex; justify-content: space-between; font-weight: 600; }
.cell__model { opacity: .6; font-size: .7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cell__status { margin-top: .25rem; }
.cell__activity { opacity: .75; font-size: .7rem; height: 1rem; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.cell__usage { opacity: .5; font-size: .7rem; }
.leaderboard { width: 100%; border-collapse: collapse; font-size: .85rem; }
.leaderboard th, .leaderboard td { text-align: left; padding: .25rem .4rem; border-bottom: 1px solid #8882; }
.controls { display: grid; gap: .5rem; margin-bottom: 1rem; }
textarea { width: 100%; font: inherit; padding: .4rem; }
button { padding: .5rem .8rem; font: inherit; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
.muted { opacity: .6; font-size: .85rem; }
.error { color: #ef4444; font-size: .85rem; }
```

- [ ] **Step 5: Replace `web/src/App.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react'
import './styles.css'
import { createRun, getRun, startRound, type RunSnapshot } from './api.js'
import { useLiveRun } from './useLiveRun.js'
import { AgentGrid } from './components/AgentGrid.js'
import { Leaderboard } from './components/Leaderboard.js'
import { RoundControls } from './components/RoundControls.js'

export function App() {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const live = useLiveRun(snapshot)

  const refresh = useCallback(async (runId: string) => {
    try {
      setSnapshot(await getRun(runId))
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const { runId } = await createRun('dashboard', 'Produce the best possible answer.')
        await refresh(runId)
      } catch (e) {
        setError(String(e))
      }
    })()
  }, [refresh])

  // A finished round changes the roster and the scores, so re-read the snapshot.
  useEffect(() => {
    if (!snapshot) return
    if (live.busy) return
    if (live.roundIdx === 0) return
    void refresh(snapshot.runId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.busy, live.roundIdx])

  if (error) return <p className="error">{error}</p>
  if (!snapshot) return <p className="muted">Starting…</p>

  const busy = live.busy || snapshot.busy

  return (
    <>
      <h1>Agent Tournament — {snapshot.name}</h1>
      <div className="layout">
        <AgentGrid agents={snapshot.agents} live={live} />
        <aside>
          <RoundControls
            goal={snapshot.goalMd ?? 'Produce the best possible answer.'}
            busy={busy}
            roundIdx={snapshot.lastRoundIdx}
            onRun={(goalMd) => {
              void startRound(snapshot.runId, goalMd).catch((e) => setError(String(e)))
            }}
          />
          <h2 style={{ fontSize: '.9rem' }}>Leaderboard</h2>
          <Leaderboard agents={snapshot.agents} live={live} />
          {live.lastBreach && <p className="error">Budget: {live.lastBreach}</p>}
        </aside>
      </div>
    </>
  )
}
```

- [ ] **Step 6: Verify manually**

Terminal 1: `npm run dashboard -- --port 4300 --population 8`
Terminal 2: `npm run web:dev`

Open http://127.0.0.1:4301. Expected: eight agent cells, a goal box, and a "Run round 1" button.
Click it. Expected: cells turn blue as agents start, green as they finish, the leaderboard fills in
with ranks, and the button re-enables reading "Run round 2".

- [ ] **Step 7: Commit**

```bash
git add web/ 
git commit -m "feat: add the live arena grid, leaderboard and round controls"
```

---

## Task 13: End-to-end dashboard test

**Files:**
- Create: `test/server/dashboard.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'
import { DEFAULT_CONFIG, type RunConfig } from '../../src/core/types.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { TournamentEngine } from '../../src/engine/driver.js'
import type { EngineEvent } from '../../src/engine/events.js'
import { Judge } from '../../src/judge/judge.js'
import { Reflector } from '../../src/evolution/reflect.js'
import { MockAgentRunner } from '../../src/runtime/agent-runner.js'
import { MockProvider } from '../../src/runtime/mock-provider.js'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'
import { buildApi } from '../../src/server/api.js'
import { RunManager } from '../../src/server/run-manager.js'
import { EventBroadcaster } from '../../src/server/ws.js'

describe('dashboard end to end', () => {
  test('a browser client sees a round play out over the websocket', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const population = 4
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      populationSize: population,
      sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: population, temperature: 0.7 }],
    }

    const broadcaster = new EventBroadcaster()
    const emit = (e: EngineEvent) => broadcaster.broadcast(e)
    const provider = new MockProvider(42)
    const sandbox = new MockSandbox()
    const engine = new TournamentEngine({
      repos, config, sandbox,
      runner: new MockAgentRunner(sandbox, 42),
      judge: new Judge(provider, config.judge, 42),
      reflector: new Reflector(provider, config.reflect, ['mock/model']),
      seedStrategy: (i) => `attempt the goal, variant ${i}`,
      onEvent: emit,
    })
    const manager = new RunManager(engine, emit)
    const app = buildApi({ repos, manager, createRun: (name) => engine.createRun(name, '').id })

    const wss = new WebSocketServer({ server: app.server, path: '/ws' })
    broadcaster.attach(wss)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const received: EngineEvent[] = []
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise((r) => socket.on('open', r))
    socket.on('message', (raw) => received.push(JSON.parse(String(raw))))

    const created = await app.inject({
      method: 'POST', url: '/api/runs', payload: { name: 'e2e', goal: 'g' },
    })
    const { runId } = JSON.parse(created.body)

    const started = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'write a good answer' },
    })
    expect(started.statusCode).toBe(202)

    await manager.waitForIdle(runId)
    await new Promise((r) => setTimeout(r, 200))

    socket.close()
    await app.close()

    const types = new Set(received.map((e) => e.type))
    expect(types.has('round.status')).toBe(true)
    expect(types.has('agent.status')).toBe(true)
    expect(types.has('round.scored')).toBe(true)
    expect(types.has('round.complete')).toBe(true)

    const scored = received.find((e) => e.type === 'round.scored')
    expect(scored && 'scores' in scored ? scored.scores : []).toHaveLength(population)

    const snapshot = await app.inject({ method: 'GET', url: `/api/runs/${runId}` })
    expect(JSON.parse(snapshot.body).lastRoundIdx).toBe(1)
  }, 60_000)
})
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/server/dashboard.e2e.test.ts`
Expected: PASS. This proves the whole chain — HTTP command, background round, engine events,
websocket delivery, and a snapshot reflecting the completed round.

- [ ] **Step 3: Full suite**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add test/server/dashboard.e2e.test.ts
git commit -m "test: prove a round reaches a websocket client end to end"
```

---

## Self-review

**Spec coverage.** Design spec §13 API: `POST /api/runs`, `GET /api/runs`, `GET /api/runs/:id`,
`POST /api/runs/:id/rounds`, `WS /ws` → Tasks 8, 9. §14 UI arena (agent cells with label, model,
status, activity, tokens; leaderboard; round controls) → Task 12.

**Deferred to Phase 4b, deliberately:** agent-detail drawer, strategy diffs, fitness-over-time chart,
model-share chart, lineage tree, diversity metric, run-setup screen with roster/sandbox
configuration, and `PATCH /api/runs/:id/config`. Also deferred: add/remove agents between rounds, and
real/Docker sandbox modes in the server — Task 9 wires mock mode so the dashboard is developable
without spending money or needing Docker.

**Type consistency.** `EngineEvent` is defined once in Task 1 and consumed unchanged by the driver
(Task 2), the run manager (Task 5), the bridge (Task 6), the broadcaster (Task 8) and the web
reducer (Task 11). `RunSnapshot` is defined in Task 4 and mirrored in `web/src/api.ts` (Task 10) —
that duplication is deliberate, since the web bundle should not import server code, but the shapes
must stay in step.

**Two risks worth stating.**

1. **The event bridge is unused in 4a.** Task 6 builds and tests it, but Task 9 wires mock mode,
   which has no OpenCode server to subscribe to. That is intentional — the grid must render from
   engine events alone — but it means the bridge's live behaviour is not exercised end to end until
   real mode arrives in 4b. Its parsing and mapping are unit-tested; its subscription is not. This is
   exactly the "built but never wired" shape that has bitten this project twice, so it is flagged
   rather than assumed working.

2. **`liveReducer` resets agents on `round.status: 'preparing'`.** If the driver ever stops emitting
   that specific status first, stale badges persist. Task 2's test asserts the lifecycle order, which
   pins it.

---

## Definition of done

- [ ] `npm test` passes with every test green
- [ ] `npm run typecheck` exits 0
- [ ] `npm run dashboard` starts and serves the API
- [ ] `npm run web:dev` serves the UI and it renders the agent grid
- [ ] Clicking "Run round" turns cells blue then green, and fills the leaderboard, without a page reload
- [ ] The end-to-end test proves `round.status`, `agent.status`, `round.scored` and `round.complete` all reach a websocket client
- [ ] A subscriber that throws does not fail a tournament round
