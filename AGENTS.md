# AGENTS.md

Guidance for AI agents (and humans) working in this repo.

## Build / test / lint gate

Run all three before claiming work is done. All must pass.

```powershell
npm test           # vitest run — 1,416 cases; see the platform split below
npm run typecheck  # tsc --noEmit — expect exit 0, no output
npm run web:build  # vite build — expect exit 0
```

CI (`.github/workflows/ci.yml`) runs the same three gates on Ubuntu with Node 24.

- 10 skips are the opt-in suites needing real services: `test/e2e/real-tournament.test.ts` (`ARENA_E2E=1`), `test/e2e/docker-tournament.test.ts` and `test/e2e/container-policy.test.ts` (`ARENA_DOCKER_E2E=1`), and `test/e2e/dashboard-real.test.ts` (`ARENA_DASHBOARD_E2E=1`).
- 8 are the file-symlink cases in `test/runtime/workspace-links.test.ts`. Creating a file symlink on Windows needs SeCreateSymbolicLink (Developer Mode or admin); without it the probe gets EPERM and those 8 skip. Directory-junction coverage runs regardless. On Linux they RUN — if they skip there, the capability probe is broken, not the platform.
- `test/runtime/opencode/server.test.ts` has one POSIX-only termination test (skipped on win32) and five win32-only taskkill tests (skipped on POSIX).
- Baseline at 2026-09-21, 1,416 total cases on every platform: **Windows 1,397 passed / 19 skipped; Linux 1,401 passed / 15 skipped.** If the total changes without a test being added or removed, a test silently stopped being collected. If passed drops, you broke something.
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
docs/                 # operator-guide, api-reference, architecture; docs/README.md indexes the rest
docs/superpowers/     # SDD specs + plans (phase history)
```

## Workflow conventions

- **Branch**: feature work on a `phase<N>-<topic>` branch off `master`; fast-forward merge to `master` when the final review passes (no `main` — `master` is the default branch on GitHub too).
- **SDD**: specs in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, plans in `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`, ledger in `.superpowers/sdd/<phase>/progress.md` (gitignored — local working file).
- **Commits**: lowercase `feat:`/`fix:`/`test:`/`docs:` prefix, short imperative subject. One commit per task/feature.
- **Subagent-driven dev**: fresh implementer per task, reviewer per task, ONE fix wave after final review. See `docs/superpowers/plans/` for the pattern.
- **Do not commit `.superpowers/sdd/`** — it's gitignored (local SDD state).

## Deployment (local dashboard)

One command builds the UI, serves it and the API from one port (`http://127.0.0.1:4300`), and opens the browser:

```powershell
npm start
```

Or double-click `Start Agent Tournament.cmd` in the project root. No flags are needed:

- data in `runs/dashboard.db`, so runs persist across restarts (`--db :memory:` for a throwaway session);
- workspaces in `runs/workspaces`;
- credentials from `~/.local/share/opencode/auth.json` when that file exists (honours `XDG_DATA_HOME`).

Every default has a flag (`--port`, `--db`, `--workspace-root`, `--auth-file`, `--server-url`, `--population`, `--no-open`), passed after `--`. Launching while it is already running opens the running instance instead of failing, and does so before touching the database — a second instance's startup recovery would otherwise mark the first one's in-flight round failed.

No `OPENCODE_SERVER_*` clearing is needed any more: the one place opencode is spawned (`src/runtime/opencode/server.ts`) scrubs those variables itself.

For UI work with hot reload, run the API and the Vite dev server separately. Vite proxies `/api/*` and `/ws` to the API port via `vite.config.ts`:

```powershell
npm run dashboard -- --no-open
npm run web:dev   # http://localhost:4301 — localhost, not 127.0.0.1 (Vite binds IPv6)
```

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
