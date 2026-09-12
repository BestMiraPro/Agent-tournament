# AGENTS.md

Guidance for AI agents (and humans) working in this repo.

## Build / test / lint gate

Run all three before claiming work is done. All must pass.

```powershell
npm test           # vitest run — expect 938 passed / 12 skipped
npm run typecheck  # tsc --noEmit — expect exit 0, no output
npm run web:build  # vite build — expect exit 0
```

- 3 of the skips are gated suites needing real services: `test/e2e/real-tournament.test.ts` (`ARENA_E2E=1`), `test/e2e/docker-tournament.test.ts` (`ARENA_DOCKER_E2E=1`) and `test/e2e/dashboard-real.test.ts` (`ARENA_DASHBOARD_E2E=1`).
- The other 8 are the file-symlink cases in `test/runtime/workspace-links.test.ts`. Creating a file symlink on Windows needs SeCreateSymbolicLink (Developer Mode or admin); without it the probe gets EPERM and those 8 skip. Directory-junction coverage runs regardless. On Linux/macOS all 8 should RUN — if they still skip there, the capability probe is broken, not the platform.
- The 12th is the POSIX branch of `stopChild` in `test/runtime/opencode/server.test.ts`, skipped on win32; the four win32 taskkill tests skip on POSIX instead.
- 938/12 is the WINDOWS figure. 950 total cases is platform-independent, but the passed/skipped split is not: on Linux/macOS the eight symlink tests and the POSIX termination test should run while the four win32 tests skip. Measure the Linux baseline on the first Linux run instead of deriving it — and check the total is still 950, which is what catches a test that silently stopped being collected.
- Baseline on `phase5-review-fixes` at `21aa2e7`: 938 passed / 12 skipped. If your count drops below this, you broke something.
- There is no separate lint script — `typecheck` is the type gate.

## Stack

- **Runtime**: Node 24, TypeScript 5.7 strict (`noUncheckedIndexedAccess` on), ESM (`"type": "module"`).
- **Test**: Vitest 4. Tests live in `test/` mirroring `src/` + `web/src/` (`test/web/`, `test/server/`, `test/engine/`, etc.).
- **Server**: Fastify 5 + ws 8 (WebSocket). Entry: `src/server/index.ts` (`npm run dashboard`).
- **Web**: React 19 + Vite 8. Entry: `web/src/main.tsx` (`npm run web:dev` / `npm run web:build`).
- **DB**: `node:sqlite` (better-sqlite3-style sync API), schema in `src/db/schema.ts`, migrations in `src/db/migrate.ts`.
- **No frontend lint/format deps** — match the existing style (2-space indent, function declarations, className strings).

## Layout

```
src/
  cli.ts              # CLI entry (npm run tournament)
  core/               # types, rng, selection, analytics, genome
  db/                 # open, repos, migrate, recover, schema
  engine/             # driver, budget, events, capture, pool
  evolution/          # breed, reflect, recombine, prompts, schemas
  judge/              # judge, prompts, parse, schemas
  runtime/            # sandbox abstraction + mock/local/docker/opencode implementations
  server/             # api, index, state, runs, run-manager, run-spec, compose-run, event-bridge, ws, export
web/
  src/                # App.tsx, api.ts, useLiveRun.ts, components/, lib/, styles.css
test/                 # mirrors src/ + web/src/
docs/                 # operator-guide, api-reference, architecture (this phase 4k)
docs/superpowers/     # SDD specs + plans (phase history)
```

## Workflow conventions

- **Branch**: feature work on a `phase<N>-<topic>` branch off `master`; fast-forward merge to `master` when the final review passes (no `main`, no remote — `master` is the default).
- **SDD**: specs in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, plans in `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`, ledger in `.superpowers/sdd/<phase>/progress.md` (gitignored — local working file).
- **Commits**: lowercase `feat:`/`fix:`/`test:`/`docs:` prefix, short imperative subject. One commit per task/feature.
- **Subagent-driven dev**: fresh implementer per task, reviewer per task, ONE fix wave after final review. See `docs/superpowers/plans/` for the pattern.
- **Do not commit `.superpowers/sdd/`** — it's gitignored (local SDD state).

## Deployment (local dashboard)

The dashboard runs as two processes (API + Vite dev server):

```powershell
# API + WS on :4300 (scrubs OPENCODE_SERVER_* leaked by the desktop app)
$env:OPENCODE_SERVER_USERNAME=""; $env:OPENCODE_SERVER_PASSWORD=""
npm run dashboard -- --db arena.db --workspace-root runs --auth-file "$env:USERPROFILE\.local\share\opencode\auth.json"

# Vite UI on :4301 (use localhost, not 127.0.0.1 — IPv6 bind)
npm run web:dev
```

The UI proxies `/api/*` and `/ws` to the API port via `vite.config.ts`.

## Real-mode e2e (optional, costs real LLM tokens)

```powershell
$env:ARENA_E2E="1"; npm test                    # local real mode
$env:ARENA_DOCKER_E2E="1"; npm test             # docker real mode
```

Requires opencode `auth.json` at `~/.local/share/opencode/auth.json` (or `ARENA_DOCKER_AUTH_FILE`).

## Key rulings (don't re-litigate)

- **judgeMode only, never judge model** in round-detail (PATCH can change the judge mid-run; rounds don't store the model — reporting current config per round would mislead).
- **Pricing is 4-key** (`inPerM/outPerM/cacheReadPerM/cacheWritePerM`) — the engine's `assertPrice` fail-closes without cache rates.
- **Abort is cooperative** — queued agents stop; in-flight sessions finish their current call; the round fails with a partial score set.
- **workspaceRoot must be absolute** (docker bind-mounts + local workspace mkdir need it).
- **Rejudge is non-destructive** (dry-run returns old-vs-new; no DB write).
- **Export reuses `buildJsonDump`** — comparison fetches the export JSON, client-side diffs; no separate compare endpoint.
