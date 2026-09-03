# Phase 4b: Real Modes + Run Setup — Design

Date: 2026-09-03. Parent: Phase 4a live arena dashboard (mock-only server).
Decomposition: 4b (this spec: real/local/docker in server + setup + config) then 4c
(analytics views). Sequential order approved: 4c endpoints depend on 4b shapes.

## 1. Architecture

Extract CLI's real-mode composition (`src/cli.ts`: `validateRosterModels`,
capacity preflight via `planCapacity`/`readHostCapacity`, local/docker sandbox
builders, `OpenCodeClient`/`OpenCodeProvider`/`OpenCodeAgentRunner`,
`attachServer`/`startServer`, `sweepOrphanContainers`) into a shared module
(e.g. `src/server/compose-run.ts`) used by both CLI and `src/server/index.ts`.

Server moves from one global mock engine to per-run engine instances:
`POST /api/runs` builds a per-run engine plus `RunManager` for its spec and
stores them keyed by runId; all runs share the single `EventBroadcaster`
(unchanged global fan-out; events already carry runId and the hook dispatches
all frames, per the 4a deferred note). `RunManager` per run drives rounds in
background; event bridge subscribes per OpenCode
endpoint in real modes with REQUIRED `?directory=` (Phase 4a silent-heartbeat
trap: without it only heartbeats arrive and the grid shows nothing forever).

No changes to engine, judge, evolution, or sandbox behavior — composition only.

Out of scope: analytics views (4c: drawer, diffs, fitness chart, lineage,
model-share, diversity), add/remove agents mid-run, 100-agent load proof.

## 2. Components and endpoints

`POST /api/runs` accepts a full run-spec (Zod-validated):
`{ name, goal, sandbox: 'mock' | 'local' | 'docker', roster: RosterEntry[],
judge, reflect, budget, seedDir, workspaceRoot, authFile, serverUrl? }`.
Rules: population equals the sum of roster counts; `docker` requires
`authFile` (bind-mounted read-only; without it every agent fails on first
model call) plus a capacity preflight refusal with headroom numbers;
`(model, role)` probes reuse the CLI fatal/warning split (judge/reflect
unusable fatal, one bad worker warns and self-heals via heritable `modelId`,
all workers bad fatal).

`PATCH /api/runs/:id/config` adjusts roster/budget/judge between rounds, taking
effect from the next round (never mid-round):
409 while its run is busy, 400 on unknown model keys or population mismatch
(roster counts must still sum to the run's population).

`GET /api/runs/:id` snapshot gains `{ sandbox, roster, capacity, warnings }`
(`capacity`: committed vs free Docker headroom plus `maxContainers`)
alongside the 4a fields plus `busy`/`lastError`.

Web: a run-setup screen replaces the auto-created `dashboard` run — goal box,
sandbox picker (mock/local/docker), roster editor (model + count +
temperature rows), budget display, and validation/capacity warnings. Existing
arena (grid, leaderboard, round controls) unchanged and consumes the same
snapshot plus live events.

## 3. Data flow, errors, testing

Lifecycle per run: create (validate spec) → validate models (fatal/warn) →
capacity preflight (docker) → provision → round loop via `RunManager`.
Progress reaches the browser through engine events over `/ws` plus snapshot
refresh after each round, as in 4a.

Errors: spec/model/capacity failures return before any spend (400 validation,
409 capacity with committed-vs-free numbers, setup abort on fatal probe);
round-time failures reuse 4a semantics (`round.complete` with breach message,
`lastError` surfaced, throwing subscriber never fails a round); concurrent
round/config on a busy run returns 409.

Testing: API validation tests (bad roster sum, docker without auth, unknown
model key, PATCH while busy/idle), composition matrix tests for
mock/local/docker wiring with fakes (no daemon/creds needed), real-mode e2e
skipped without Docker/credentials following the existing e2e-skip pattern.
Gate: `npm test` green (2 pre-existing e2e skips), `npm run typecheck` exit 0,
`npm run web:build` exit 0, dashboard smoke `GET /api/runs` 200.
