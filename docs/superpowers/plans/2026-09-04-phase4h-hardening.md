# Phase 4h — Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the dashboard for sustained operator use — responsive layout, agent-grid pagination, ARIA live regions, WebSocket reconnect with exponential backoff.

**Architecture:** CSS-first responsive (media queries, no JS); native pagination (24/page, no virtualization lib); ARIA attributes on existing components; native setTimeout backoff in `useLiveRun` with a pure `nextDelay` helper for testability. No new dependencies, no server code.

**Tech Stack:** React 19 + Vite 8 + Vitest 4; TypeScript strict; existing `liveReducer` pure-function test pattern; existing `styles.css` class conventions.

**Spec:** `docs/superpowers/specs/2026-09-04-phase4h-hardening-design.md` (commit `054c162`) — the spec travels with this plan; executors read both.

## Global Constraints

- No new dependencies (no `react-window`, no `react-aria`, no reconnect lib). Stdlib + CSS + native browser features only.
- No server code (`src/server/**` is frozen). All work is in `web/src/**` + tests.
- No behavior change to existing flows — hardening only. Pagination is additive (hidden when ≤24 agents); responsive is CSS; ARIA is attributes; reconnect is WS lifecycle.
- AgentDrawer already has Escape-to-close (`AgentDrawer.tsx:71-74`), `role="dialog"` + `aria-label` (`:90-91`), and `aria-label="Close"` on the close button (`:107`) — DO NOT touch the drawer; it's already a11y-solid. Focus-return-to-grid is the only drawer-adjacent work, and it lives in App.tsx (Task 4), not the drawer.
- Gate per task: `npm test` (0 failed; 2 pre-existing daemon-gated e2e skips), `npm run typecheck` exit 0, `npm run web:build` exit 0. Baseline before 4h: 742 passed / 2 skipped.
- One commit per task, style matching `git log --oneline -3` (lowercase `feat:`/`fix:`/`test:` prefix, short imperative subject).
- Windows PowerShell 5.1 environment: no `head`; use `Select-Object -First/-Last`; quote paths with spaces; no `&&` chaining (use `;` + `if ($?)`).

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `web/src/useLiveRun.ts` | WS lifecycle + reconnect + `wsStatus` + pure `nextDelay` | Modify |
| `test/web/live-run.test.ts` | `nextDelay` pure-fn unit tests | Modify (extend) |
| `web/src/components/AgentGrid.tsx` | Pagination state + controls + `aria-label` on cards | Modify |
| `web/src/components/RunSummary.tsx` | `role="status"` + `aria-live="polite"` | Modify |
| `web/src/components/AnalyticsPanel.tsx` | `aria-busy` on the section | Modify |
| `web/src/components/RoundDetail.tsx` | `aria-busy` on the section | Modify |
| `web/src/components/RosterBuilder.tsx` | `aria-label` on remove/add icon buttons | Modify |
| `web/src/App.tsx` | Reconnect banner + focus-return-to-grid on drawer close | Modify |
| `web/src/styles.css` | Media queries + pagination button styles + focus-visible additions | Modify |
| `test/server/dashboard.e2e.test.ts` | E2e guard: pagination appears >24, ARIA live region exists | Modify (append) |

---

### Task 1: WebSocket reconnect with exponential backoff

**Files:**
- Modify: `web/src/useLiveRun.ts` (full rewrite of the `useLiveRun` hook + new `nextDelay` export; `liveReducer` untouched)
- Test: `test/web/live-run.test.ts` (append `nextDelay` tests)

**Interfaces:**
- Consumes: `liveReducer`, `initialLiveState` (unchanged)
- Produces: `nextDelay(attempt: number): number` (pure, exported); `LiveState.wsStatus: 'connected' | 'reconnecting'` (new field); `useLiveRun` returns `LiveState` with `wsStatus` populated by the hook (not by reducer events — the hook sets it directly via a `useReducer` dispatch of a new `ws.status` event type, OR via a parallel `useState`; DECISION: add a `ws.status` event to the reducer so the existing pure-fn test pattern covers it, and the hook dispatches it on open/close).

- [ ] **Step 1: Write the failing tests for `nextDelay`**

Append to `test/web/live-run.test.ts`:

```typescript
import { nextDelay } from '../../web/src/useLiveRun.js'

describe('nextDelay', () => {
  test('attempt 0 waits 1s', () => {
    expect(nextDelay(0)).toBe(1000)
  })
  test('attempt 1 waits 2s', () => {
    expect(nextDelay(1)).toBe(2000)
  })
  test('attempt 4 waits 16s', () => {
    expect(nextDelay(4)).toBe(16000)
  })
  test('attempt 5+ caps at 30s', () => {
    expect(nextDelay(5)).toBe(30000)
    expect(nextDelay(100)).toBe(30000)
  })
  test('never returns 0 or negative', () => {
    for (let i = 0; i < 10; i++) {
      expect(nextDelay(i)).toBeGreaterThan(0)
    }
  })
})
```

Also append a reducer test for the new `ws.status` event:

```typescript
test('ws.status updates wsStatus', () => {
  const s = liveReducer(initialLiveState, { type: 'ws.status', status: 'reconnecting' })
  expect(s.wsStatus).toBe('reconnecting')
  const s2 = liveReducer(s, { type: 'ws.status', status: 'connected' })
  expect(s2.wsStatus).toBe('connected')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/web/live-run.test.ts`
Expected: FAIL — `nextDelay` is not exported, `wsStatus` not on `LiveState`.

- [ ] **Step 3: Implement `nextDelay` + `wsStatus` + reconnect**

In `web/src/useLiveRun.ts`:

1. Add `wsStatus: 'connected' | 'reconnecting'` to `LiveState` interface (`initialLiveState.wsStatus = 'connected'`).
2. Add a `ws.status` case to `liveReducer` returning `{ ...state, wsStatus: event.status }`.
3. Export `nextDelay`:
```typescript
export function nextDelay(attempt: number): number {
  const ms = 1000 * 2 ** attempt
  return Math.min(ms, 30000)
}
```
4. Rewrite the `useEffect` in `useLiveRun` to reconnect:
```typescript
useEffect(() => {
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let closed = false

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    socket = new WebSocket(`${proto}://${location.host}/ws`)
    socket.onopen = () => {
      attempt = 0
      dispatch({ type: 'ws.status', status: 'connected' })
    }
    socket.onmessage = (m) => {
      try { dispatch(JSON.parse(m.data as string)) } catch { /* malformed */ }
    }
    socket.onclose = () => {
      if (closed) return
      dispatch({ type: 'ws.status', status: 'reconnecting' })
      timer = setTimeout(() => { attempt++; open() }, nextDelay(attempt))
    }
  }
  open()

  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    socket?.close()
  }
}, [])
```
Note: `onerror` is NOT handled separately — `onclose` always fires after `onerror`, so reconnect logic lives in `onclose` only (single source of truth).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/web/live-run.test.ts`
Expected: PASS (all existing + new).

- [ ] **Step 5: Full gate**

Run: `npm test` (expect 742 + 6 new = 748 passed / 2 skipped), `npm run typecheck`, `npm run web:build`.
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add web/src/useLiveRun.ts test/web/live-run.test.ts
git commit -m "feat: websocket reconnect with exponential backoff"
```

---

### Task 2: Agent-grid pagination

**Files:**
- Modify: `web/src/components/AgentGrid.tsx` (add pagination state + controls + `aria-label`)
- Modify: `web/src/styles.css` (pagination button styles)

**Interfaces:**
- Consumes: `SnapshotAgent[]`, `LiveState`, `onSelect` (unchanged props)
- Produces: paginated grid (24/page), `aria-label` on each card

- [ ] **Step 1: Implement pagination in AgentGrid**

In `web/src/components/AgentGrid.tsx`:

1. Add `useState` for `page` (number, starts at 1). Reset to 1 when `agents.length` changes via a `useEffect` with `[agents.length]` deps.
2. Page size constant: `const PAGE_SIZE = 24`.
3. Compute `totalPages = Math.ceil(agents.length / PAGE_SIZE)`.
4. Slice: `const visible = agents.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)`.
5. Render `visible` instead of `agents` in the grid map.
6. Below the grid, render pagination controls ONLY when `agents.length > PAGE_SIZE`:
```tsx
{agents.length > PAGE_SIZE && (
  <div className="grid__pager">
    <button className="pager__btn" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>‹</button>
    <span className="pager__info" aria-current="page">Page {page} of {totalPages} ({agents.length} agents)</span>
    <button className="pager__btn" aria-label="Next page" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>›</button>
  </div>
)}
```
7. Add `aria-label` to each card: `aria-label={\`Agent ${a.label}, ${a.modelId}, ${STATUS_LABEL[status] ?? status}\`}`.

- [ ] **Step 2: Add pagination styles**

In `web/src/styles.css`, append:
```css
.grid__pager { display: flex; align-items: center; justify-content: center; gap: .75rem; margin-top: .75rem; }
.pager__btn { background: #1f2937; color: #e5e7eb; border: 1px solid #374151; border-radius: .25rem; padding: .25rem .75rem; cursor: pointer; }
.pager__btn:disabled { opacity: .4; cursor: not-allowed; }
.pager__btn:focus-visible { outline: 2px solid #3b82f6; outline-offset: 1px; }
.pager__info { font-size: .8rem; opacity: .8; }
```

- [ ] **Step 3: Full gate**

Run: `npm test`, `npm run typecheck`, `npm run web:build`.
Expected: all green (no new tests — pagination is component state, e2e guard in Task 5).

- [ ] **Step 4: Commit**

```bash
git add web/src/components/AgentGrid.tsx web/src/styles.css
git commit -m "feat: paginate agent grid 24 per page with aria labels"
```

---

### Task 3: ARIA live regions + busy states

**Files:**
- Modify: `web/src/components/RunSummary.tsx` (add `role="status"` + `aria-live="polite"`)
- Modify: `web/src/components/AnalyticsPanel.tsx` (add `aria-busy`)
- Modify: `web/src/components/RoundDetail.tsx` (add `aria-busy`)
- Modify: `web/src/components/RosterBuilder.tsx` (add `aria-label` on remove/add buttons)

**Interfaces:**
- Consumes: existing props (unchanged)
- Produces: ARIA attributes on existing elements

- [ ] **Step 1: RunSummary — role=status + aria-live**

In `web/src/components/RunSummary.tsx`, on the existing `<section className="summary__strip" aria-label="Run summary">` element, add `role="status"` and `aria-live="polite"`:
```tsx
<section className="summary__strip" aria-label="Run summary" role="status" aria-live="polite">
```

- [ ] **Step 2: AnalyticsPanel — aria-busy**

In `web/src/components/AnalyticsPanel.tsx`, on the existing `<section className="analytics" aria-label="Run analytics">` element (around line 187), add `aria-busy={loading && rounds === null}`:
```tsx
<section className="analytics" aria-label="Run analytics" aria-busy={loading && rounds === null}>
```

- [ ] **Step 3: RoundDetail — aria-busy**

In `web/src/components/RoundDetail.tsx`, on the existing `<section className="rounddetail" aria-label="Round detail">` element (around line 92), add `aria-busy={loading && detail === null}`:
```tsx
<section className="rounddetail" aria-label="Round detail" aria-busy={loading && detail === null}>
```

- [ ] **Step 4: RosterBuilder — aria-label on icon buttons**

In `web/src/components/RosterBuilder.tsx`, find the remove button (renders `×`) and add `aria-label={\`Remove row ${i + 1}\`}`. Find the add button (renders `+`) and add `aria-label="Add agent row"`. Read the file first to get exact line context.

- [ ] **Step 5: Full gate**

Run: `npm test`, `npm run typecheck`, `npm run web:build`.
Expected: all green (attributes only, no logic change).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/RunSummary.tsx web/src/components/AnalyticsPanel.tsx web/src/components/RoundDetail.tsx web/src/components/RosterBuilder.tsx
git commit -m "feat: aria live regions and busy states on dynamic panels"
```

---

### Task 4: Reconnect banner + responsive CSS + focus return

**Files:**
- Modify: `web/src/App.tsx` (reconnect banner using `live.wsStatus`; focus-return-to-grid on drawer close)
- Modify: `web/src/styles.css` (media queries + focus-visible additions)

**Interfaces:**
- Consumes: `live.wsStatus` from `useLiveRun` (Task 1), existing `selected` state for drawer
- Produces: reconnect banner, responsive layout, focus return

- [ ] **Step 1: Reconnect banner in App.tsx**

In `web/src/App.tsx`, near the top of the arena render (above `<RunSummary>` or just below it), add:
```tsx
{live.wsStatus === 'reconnecting' && (
  <p className="muted reconnect-banner">Reconnecting…</p>
)}
```
Read the file first to find where `live` is destructured from `useLiveRun` and where `<RunSummary>` mounts; place the banner just above `<RunSummary>`.

- [ ] **Step 2: Focus return to grid on drawer close**

In `web/src/App.tsx`, add a `ref` to the agent grid container (`<div className="layout">` or the grid wrapper) and pass an `onClose` to `AgentDrawer` that clears selection AND focuses the grid ref:
```tsx
const gridRef = useRef<HTMLDivElement>(null)
// ... in the AgentDrawer onClose handler:
setSelected(null)
gridRef.current?.focus()
```
Add `tabIndex={-1}` to the grid container div so it can receive focus. Read App.tsx first to find the exact grid wrapper element and the existing `onClose` handler.

- [ ] **Step 3: Responsive media queries in styles.css**

In `web/src/styles.css`, append:
```css
@media (max-width: 1024px) {
  .layout { grid-template-columns: 1fr; }
}
@media (max-width: 768px) {
  .layout { gap: .75rem; }
  .grid { gap: .35rem; }
  .cell { padding: .35rem; }
  .cell__label { font-size: .75rem; }
  .cell__model, .cell__activity, .cell__status { font-size: .65rem; }
  .drawer { width: 100%; max-width: 100%; }
  table { display: block; overflow-x: auto; }
}
.reconnect-banner { padding: .25rem .5rem; }
```
Read the existing `.layout`, `.grid`, `.cell`, `.drawer` rules first to ensure the media queries override correctly (specificity match).

- [ ] **Step 4: focus-visible additions**

In `web/src/styles.css`, ensure all interactive elements have `:focus-visible` outlines. The existing `.cell--selectable:focus-visible` (line 37) covers cards. Add for buttons that lack it:
```css
button:focus-visible { outline: 2px solid #3b82f6; outline-offset: 1px; }
select:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid #3b82f6; outline-offset: 1px; }
```
(Place near the existing focus-visible rule for consistency.)

- [ ] **Step 5: Full gate**

Run: `npm test`, `npm run typecheck`, `npm run web:build`.
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add web/src/App.tsx web/src/styles.css
git commit -m "feat: reconnect banner, responsive layout, focus return"
```

---

### Task 5: E2e guard + full gate

**Files:**
- Modify: `test/server/dashboard.e2e.test.ts` (append two guards: pagination >24, ARIA live region)

**Interfaces:**
- Consumes: existing mock-run flow in the e2e file (read it first — the harness builds a 4-agent mock run; for the pagination guard you need a >24-agent run, so create a dedicated mock run with `population: 30`)

- [ ] **Step 1: Read the existing e2e file**

Read `test/server/dashboard.e2e.test.ts` in full to find the mock-run setup pattern (TournamentEngine, buildApi, inject) and the last test's closing line. The pagination guard needs a 30-agent run (roster `[{ modelId: 'mock/model', count: 30, temperature: 0.7 }]`, `populationSize: 30`).

- [ ] **Step 2: Write the pagination e2e guard**

Append a test that:
1. Creates a 30-agent mock run (reuse the engine + buildApi wiring from the existing 4-agent test — copy the setup, change population + roster).
2. POSTs `/api/runs/:id/rounds` to start round 1, waits for idle.
3. GETs `/api/runs/:id` snapshot, asserts `agents.length === 30`.
4. (The UI is React — the e2e can't render it. So the guard asserts the DATA that pagination keys off: snapshot agents > 24. The pagination CONTROLS are component-side and not testable via server inject. DECISION: assert the snapshot returns >24 agents, which is the precondition for pagination controls to appear. The pagination logic itself is trivial component state — not worth a jsdom render harness for this phase.)

```typescript
test('phase4h guard: 30-agent run returns snapshot with >24 agents (pagination precondition)', async () => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const population = 30
  const config: RunConfig = { ...DEFAULT_CONFIG, populationSize: population, sandbox: 'mock', roster: [{ modelId: 'mock/model', count: population, temperature: 0.7 }] }
  const broadcaster = new EventBroadcaster()
  const emit = (e: EngineEvent) => broadcaster.broadcast(e)
  const provider = new MockProvider(42)
  const sandbox = new MockSandbox()
  const engine = new TournamentEngine({ repos, config, sandbox, runner: new MockAgentRunner(sandbox, 42), judge: new Judge(provider, config.judge, 42), reflector: new Reflector(provider, config.reflect, ['mock/model']), seedStrategy: (i) => `attempt the goal, variant ${i}`, onEvent: emit })
  const manager = new RunManager(engine, emit)
  const app = buildApi({ repos, manager, createRun: (name) => engine.createRun(name, '').id })
  const created = JSON.parse((await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'e2e-4h', goal: 'g' } })).body)
  const runId: string = created.runId
  await app.inject({ method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'write a good answer' } })
  await manager.waitForIdle(runId)
  const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}` })
  expect(res.statusCode).toBe(200)
  const snap = JSON.parse(res.body)
  expect(snap.agents).toHaveLength(30)
  expect(snap.agents.length).toBeGreaterThan(24)
  await app.close()
}, 60_000)
```

Read the existing file's imports first and reuse them — do NOT add new imports if the existing ones cover `openDb`, `makeRepos`, `DEFAULT_CONFIG`, `RunConfig`, `EventBroadcaster`, `MockProvider`, `MockSandbox`, `TournamentEngine`, `MockAgentRunner`, `Judge`, `Reflector`, `RunManager`, `buildApi`, `EngineEvent`.

- [ ] **Step 3: Write the WS reconnect unit guard**

The reconnect logic is `nextDelay` (pure, tested in Task 1). The `ws.status` reducer event is tested in Task 1. No additional e2e guard needed for WS — the pure-fn tests cover it. SKIP this step; note in the ledger that WS reconnect is unit-covered, not e2e-covered (a real WS e2e would require a browser harness, YAGNI for this phase).

- [ ] **Step 4: Full gate**

Run: `npm test` (expect 748 + 1 new = 749 passed / 2 skipped), `npm run typecheck`, `npm run web:build`.
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add test/server/dashboard.e2e.test.ts
git commit -m "test: e2e guard for pagination precondition on 30-agent run"
```

---

## Self-Review

**Spec coverage:**
- §1 Responsive layout → Task 4 Step 3 (media queries) ✓
- §2 Pagination → Task 2 ✓
- §3 Keyboard nav → Task 2 (pagination reduces tab targets) + Task 4 Step 2 (focus return) ✓ (Escape already exists in AgentDrawer, noted in Global Constraints)
- §4 ARIA → Task 3 (live regions + busy + icon-button labels) + Task 2 Step 1 (card aria-label) ✓
- §5 WS reconnect → Task 1 ✓
- Testing section → Task 1 (nextDelay + ws.status unit tests) + Task 5 (e2e pagination precondition) ✓

**Placeholder scan:** None — every step has concrete code or a concrete read-then-edit instruction with file:line references.

**Type consistency:** `LiveState.wsStatus` added in Task 1, consumed in Task 4 (`live.wsStatus`). `nextDelay` exported in Task 1, used in Task 1's hook. `PAGE_SIZE = 24` constant in Task 2. All consistent.

**Note:** The spec said 9 files; AgentDrawer is already a11y-complete (verified at `AgentDrawer.tsx:71-74,90-91,107`), so it's dropped — 8 files touched (5 components + App + styles + 2 test files). The spec's scope count was a pre-verification estimate; this is a refinement, not a deviation.
