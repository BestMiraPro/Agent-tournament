# Agent Tournament — Design Spec

**Date:** 2026-08-22
**Status:** Approved, pending implementation plan

## 1. Problem

Run a population of tool-using AI agents in parallel against a user-chosen goal, score them, and evolve them across rounds by selection. Agents see their own evaluation, the judge's critique, and the strategies that won — so improvement is directed, not random drift.

The user controls the goal, the population, and when each round runs. Between rounds the goal may change, and agents may be added or removed.

## 2. Goals

- Population of tool-using agents (default 20, scalable toward 100) running concurrently.
- User-defined goal, editable between rounds.
- LLM-judge scoring against criteria that are either user-supplied or auto-generated.
- Genuine evolution: heritable traits, selection pressure, directed mutation.
- Mixed-provider rosters (e.g. 5 agents on a DeepSeek model, 5 on an OpenCode Zen model).
- Live dashboard: watch every agent work, inspect any agent, control the tournament.
- Highly configurable; add/remove agents after each round.

## 3. Non-goals

- Distributed execution across machines. Single host only.
- Fully automatic multi-round runs without user gating. Each round is user-triggered.
- Training or fine-tuning models. Evolution operates on prompts and configuration only.
- Multi-user or hosted deployment. Local app.

## 4. Decisions and rationale

| Decision | Choice | Why |
|---|---|---|
| Agent substrate | Tool-using agents on the OpenCode harness | User requirement. Enables goals requiring real work. |
| Execution topology | Persistent container per agent, each running `opencode serve` | Real isolation plus the SSE event bus needed for a live UI. Startup cost paid once per run, not per round. |
| Genome | The OpenCode agent markdown file | Cloning is a file copy; mutation is a file rewrite. The genome is a real artifact on disk. |
| Heritable traits | strategy text, model ID, temperature, `NOTES.md` | Model heritability puts the provider roster itself under selection pressure. |
| Workspace inheritance | Fresh each round, seeded from a user-chosen directory, plus persistent `NOTES.md` | Fitness measures the strategy, not accumulated artifacts. Notes preserve learning. |
| Judging | All submissions in one call; batched-finals fallback above ~25 | User choice. Single-call preserves cross-agent calibration; fallback prevents context blowup. |
| Criteria | User-supplied, else auto-generated from the goal; editable before scoring | User requirement. |
| Mutation | Separate non-agentic LLM call per agent | ~2% of round cost versus re-running a full agent session. |
| Elitism | Rank 1 strategy preserved verbatim | Without it a bad mutation on the best agent makes round N+1 worse; fitness wanders instead of climbing. |

## 5. Architecture

```
web/ (React + Vite + Tailwind)
  |  REST + WebSocket
server/ (Fastify + ws)  -- round driver state machine
  |  @opencode-ai/sdk, one client per agent
  +-- agent-01 container : opencode serve : /work
  +-- agent-02 container : opencode serve : /work
  +-- ...
SQLite (better-sqlite3)
```

TypeScript throughout, matching the SDK. npm workspaces.

```
agent-tournament/
  packages/
    core/        domain logic, zero I/O: genome, selection, lifecycle types
    db/          schema, migrations, repositories
    runtime/     Sandbox interface + Docker/Local/Mock impls, agent-runner, pool
    judge/       criteria generation, single-call and batched scoring
    evolution/   reflection (mutation), breeding
    server/      REST, WebSocket, round driver
    web/         dashboard
  docker/
    Dockerfile.agent
```

`core/` must remain free of I/O so selection and lifecycle logic are unit-testable without a database, a container, or a provider.

## 6. The genome

An agent's genome is its OpenCode agent definition, written to `/work/.opencode/agents/competitor.md` during PREPARE:

```markdown
---
description: competitor-07
model: opencode/deepseek-v4-flash
temperature: 0.7
permission:
  edit: allow
  bash: allow
  webfetch: deny
---
<strategy text — self-authored, heritable>
```

`NOTES.md` is written to `/work/NOTES.md` and is separately heritable.

**Strategy character cap: 2000 (configurable).** Without a cap, strategies accumulate text every generation, inflating both cost and context until rounds become unaffordable. The reflection step enforces the cap and rejects over-long rewrites.

## 7. Data model

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,                 -- active | archived
  config_json TEXT NOT NULL,
  seed_dir TEXT
);

CREATE TABLE rounds (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  idx INTEGER NOT NULL,                 -- 1-based
  goal_md TEXT NOT NULL,
  criteria_md TEXT,
  criteria_source TEXT NOT NULL,        -- user | generated
  judge_mode TEXT NOT NULL,             -- single_call | batched_finals
  status TEXT NOT NULL,                 -- pending|preparing|running|collecting|judging|evolving|reflecting|complete|failed
  started_at INTEGER, ended_at INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  UNIQUE(run_id, idx)
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  label TEXT NOT NULL,                  -- competitor-07
  parent_agent_id TEXT REFERENCES agents(id),
  born_round INTEGER NOT NULL,
  died_round INTEGER,
  status TEXT NOT NULL                  -- active | retired | culled
);

CREATE TABLE genomes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  round_idx INTEGER NOT NULL,
  strategy_md TEXT NOT NULL,
  notes_md TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL,
  temperature REAL NOT NULL,
  parent_genome_id TEXT REFERENCES genomes(id),
  origin TEXT NOT NULL,                 -- seed|elite|mutation|clone|crossover|manual
  created_at INTEGER NOT NULL,
  UNIQUE(agent_id, round_idx)
);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  genome_id TEXT NOT NULL REFERENCES genomes(id),
  submission_md TEXT,
  file_manifest_json TEXT,              -- [{path,bytes,sha256}]
  workspace_path TEXT NOT NULL,
  status TEXT NOT NULL,                 -- ok|timeout|error|no_submission
  error_text TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  duration_ms INTEGER,
  UNIQUE(round_id, agent_id)
);

CREATE TABLE scores (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  rank INTEGER NOT NULL,
  score REAL NOT NULL,                  -- normalized 0..100
  rationale_md TEXT NOT NULL,
  band TEXT,                            -- elite|top|middle|bottom
  UNIQUE(round_id, agent_id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  round_id TEXT, agent_id TEXT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
```

`genomes` is append-only and never updated; a genome row is the immutable record of what competed in a given round. Lineage is reconstructed by walking `parent_genome_id`.

## 8. Round lifecycle

State machine, persisted in `rounds.status`:

```
SETUP -> PREPARE -> RUN -> COLLECT -> JUDGE -> EVOLVE -> REFLECT -> PAUSE
```

1. **SETUP** — user supplies the goal, optionally criteria, adjusts the roster. Round row created.
2. **PREPARE** — for each active agent: reset `/work`, copy the seed directory if configured, write `.opencode/agents/competitor.md` (genome), `NOTES.md`, `GOAL.md`.
3. **RUN** — pool drives agents concurrently. Per agent: `session.create`, then `prompt_async` with the goal and the submission contract. `/event` SSE is subscribed per agent and relayed to the UI over WebSocket.
4. **COLLECT** — read `/work/SUBMISSION.md` and build a file manifest. Missing file means `status = no_submission`.
5. **JUDGE** — resolve criteria, score, persist ranks and rationales.
6. **EVOLVE** — apply selection, cull, create next-generation agent rows.
7. **REFLECT** — per surviving agent, one non-agentic call rewrites strategy and notes.
8. **PAUSE** — round marked `complete`. User reviews and triggers the next round.

**Submission contract**, appended to every agent prompt: the agent must write its final answer to `SUBMISSION.md` in its working directory; anything else in the directory is supporting evidence. The judged artifact is `SUBMISSION.md`, with the file manifest as context.

## 9. Judging

**Criteria resolution.** If the user supplied criteria, use them verbatim (`criteria_source = user`). Otherwise one LLM call derives 4–6 weighted criteria from the goal (`criteria_source = generated`). Resolved criteria are persisted and surfaced in the UI, **editable before scoring runs**. Criteria carry forward as the default for the next round when the goal is unchanged.

**Anonymization.** Submissions are presented to the judge as opaque shuffled refs (`S1..SN`), with agent labels and model IDs withheld and presentation order reshuffled each round. Without this the judge can favor a recognizable label or a model it prefers, and a fixed order induces position bias that would then be inherited as if it were fitness.

**Failed agents are never sent to the judge.** Submissions with `status` of `timeout`, `error`, or `no_submission` are excluded from the judge call entirely, then appended below the ranked agents in arbitrary order with `score = 0`. This keeps failures out of the judge's context (where they would distort the comparative scale) while still placing them in the bottom band where selection culls them.

**Single-call mode** (population ≤ `singleCallMaxPopulation`, default 25). One call containing the goal, criteria, and all submissions truncated to `submissionCharCap` (default 6000, head and tail preserved). Returns strict JSON: `{ rankings: [{ref, rank, score, rationale}], meta_digest }`.

**Batched-finals mode** (population > 25, or on single-call failure). Submissions split into batches of `batchSize` (default 5) and ranked within batch; batch winners advance to a finals ranking; non-finalists are scored by interpolation from their batch position.

`meta_digest` is a short natural-language summary of what separated winners from losers. It is the highest-signal input to reflection and is shown in the UI.

## 10. Evolution

**Selection**, on ranked agents 1..N (all values configurable):

| Band | Default | Fate |
|---|---|---|
| Elite | rank 1 | Strategy preserved verbatim, no mutation, `origin = elite` |
| Top | 20% | Survive and mutate; serve as the source pool for clones |
| Middle | 60% | Survive and mutate |
| Bottom | 20% | Culled; slots refilled by clones drawn round-robin from the top band |

Precise rule, so the bands stay consistent when the ratios are changed from their defaults:

```
bottomCount = floor(N * bottomPct)
topCount    = max(eliteCount, floor(N * topPct))
culled      = ranks (N - bottomCount + 1) .. N
clones      = exactly bottomCount, parents drawn round-robin from ranks 1..topCount
```

The number of clones always equals the number culled, so **population size is invariant across selection** regardless of how `topPct` and `bottomPct` are set. Population changes only by explicit user action.

The elite band is a **subset** of the top band, not a separate band: rank 1 is both elite (strategy preserved verbatim) and a clone parent. `eliteCount` must be less than or equal to `topCount`.

**Reflection (the mutation operator).** One non-agentic LLM call per surviving agent.

Input: own strategy, own notes, own rank/score/rationale, the top-K (default 5) other agents' strategies with submission excerpts and rationales, the `meta_digest`, and the goal for the next round if it changed.

Output: strict JSON `{ strategy_md, notes_md, model_id?, temperature? }`.

Guardrails: `strategy_md` truncated to the cap; `model_id` must be in the run's allowed roster or is discarded; `temperature` clamped to 0..1; malformed JSON gets one repair attempt, then the previous genome is carried forward unchanged.

**Population edits between rounds.** Add: user picks model, temperature, and either a blank strategy (generated from the goal), a pasted strategy, or a clone of an existing agent. Remove: `status = retired`, `died_round` set; the container is torn down.

## 11. Sandbox layer

```ts
interface Sandbox {
  provision(agentId: string, opts: { seedDir?: string }): Promise<AgentHandle>
  reset(handle: AgentHandle, opts: { seedDir?: string }): Promise<void>
  writeFile(handle: AgentHandle, relPath: string, content: string): Promise<void>
  readFile(handle: AgentHandle, relPath: string): Promise<string | null>
  listFiles(handle: AgentHandle): Promise<FileEntry[]>
  endpoint(handle: AgentHandle): { baseUrl: string }
  teardown(handle: AgentHandle): Promise<void>
}
```

Three implementations: `DockerSandbox` (production), `LocalSandbox` (dev, no isolation), `MockSandbox` (tests, in-memory).

**Docker specifics.** Image `agent-arena:latest` from `docker/Dockerfile.agent`: Node 24 slim base, OpenCode CLI installed, entrypoint `opencode serve --hostname 0.0.0.0 --port 4096`.

```
docker run -d --name arena-<run>-<agent> \
  -m 1g --cpus 1 \
  -p 127.0.0.1:0:4096 \
  -v <hostAgentDir>:/work \
  -v <opencodeAuth>:/root/.local/share/opencode/auth.json:ro \
  agent-arena:latest
```

Host port is ephemeral; the actual port is read back via `docker port`.

**Credential propagation is an implementation-verification item.** Mounting `auth.json` read-only covers gateways that persist credentials there (the W&B credential on this machine is stored that way). OpenCode Zen may keep its key elsewhere, so Phase 2 must confirm empirically where each configured provider's credential lives and mount or inject accordingly. The sandbox exposes a `credentials` config block rather than hardcoding a single mount path.

**Networking.** Containers use the default bridge network, not `--network none`: opencode must reach the provider gateway over HTTPS, and full network isolation would break every agent. Agent-level browsing is blocked instead via `permission.webfetch: deny` in the genome. Optional hardening: set `HTTPS_PROXY` to a host-side allowlist proxy permitting only provider domains. This is a deliberate tradeoff — the runtime has egress, the agent has no browsing tool.

**Containers persist for the life of the run**, not per round. PREPARE resets `/work` rather than recreating the container, so startup cost is paid once.

**Sharding.** Above `maxContainers` (default 12 on this host, see §20), agents share containers, each using a separate session and subdirectory. Trades per-agent isolation for memory headroom; this is the path to a 100-agent population on one machine.

## 12. Providers and cost

Models are referenced in OpenCode format, `provider/model-id` (e.g. `opencode/deepseek-v4-flash`). Available models are discovered from the running opencode server rather than hardcoded, so the roster picker reflects whatever the user has authenticated.

Roster configuration assigns counts per model:

```jsonc
"roster": [
  { "modelId": "opencode/deepseek-v4-flash", "count": 10, "temperature": 0.7 },
  { "modelId": "opencode/big-pickle",        "count": 10, "temperature": 0.9 }
]
```

Model IDs above are illustrative. The roster picker is populated from `GET /api/models`, which proxies whatever the running opencode server reports as authenticated and available — no model list is hardcoded anywhere in the codebase.

Counts must sum to `populationSize`; the run cannot start if they do not.

**Default roster (20 agents), using only gateways verified live in §20:**

```jsonc
"roster": [
  { "modelId": "opencode/muse-spark-1.2-contributor-free", "count": 5, "temperature": 0.7 },
  { "modelId": "opencode/big-pickle",                      "count": 5, "temperature": 0.8 },
  { "modelId": "opencode/nemotron-3.5-lightning-free",     "count": 5, "temperature": 0.9 },
  { "modelId": "wandb/deepseek-ai/DeepSeek-V4-Flash",      "count": 5, "temperature": 0.7 }
]
```

Fifteen of twenty agents run on free inference. Because `model_id` is heritable, this mix
is only a starting distribution — if one model consistently wins, its share grows by
selection, which doubles as a live benchmark of the models against each other on the
user's own goal.

**Judge default: `wandb/zai-org/GLM-5.2`.** The judge is the one component where model
strength changes outcome quality, since a noisy judge yields noisy fitness and weakens
selection. Alternatives on the same gateway: `deepseek-ai/DeepSeek-V4-Pro`,
`Qwen/Qwen3-Coder-480B-A35B-Instruct`.

`wandb/moonshotai/Kimi-K3` was the original default here, but a live-server spike found
it listed as available and yet returning a 404 on every call — listed-but-not-callable,
not merely weak. `zai-org/GLM-5.2` was verified callable with structured output and
correctly ranked a real 3-way comparison, so it replaced Kimi-K3 as the default. This is
exactly the failure mode `validateRosterModels`'s pre-flight check now catches before a
run starts, rather than after agents have already run.

**Reflection default: `wandb/deepseek-ai/DeepSeek-V4-Flash`.** Reflection is a short
structured-output task, but it is the mutation operator, so quality here directly shapes
evolution. Cheaper than the judge, stronger than the free tier.

These three model choices are **defaults to validate empirically in Phase 2**, not
benchmarked recommendations — no comparative evaluation of these specific models on
judging or reflection tasks was performed. Phase 2 should A/B at least the judge against
one alternative before long runs are trusted. Because `model_id` is heritable, the realized mix drifts from the seed mix as selection proceeds; the UI charts model share per round.

**Cost tracking.** Token usage is read from opencode message responses and multiplied by a per-model price table in run config. A model with no price entry records cost 0 and sets a `pricing_missing` flag, surfaced in the UI so totals are never silently wrong.

**Concurrency** defaults to 8 simultaneous active prompts regardless of container count, because provider rate limits rather than container count are the binding constraint.

## 13. Server API

```
POST   /api/runs                        create run
GET    /api/runs                        list
GET    /api/runs/:id                    run, agents, round summaries
PATCH  /api/runs/:id/config             update config between rounds
POST   /api/runs/:id/agents             add agent
DELETE /api/runs/:id/agents/:agentId    retire agent
POST   /api/runs/:id/rounds             start next round { goal_md, criteria_md? }
GET    /api/rounds/:id                  round detail, scores, submissions
POST   /api/rounds/:id/criteria         override criteria before scoring
POST   /api/rounds/:id/abort            abort in-flight round
GET    /api/agents/:id/lineage          ancestry chain
GET    /api/submissions/:id             full submission and manifest
GET    /api/models                      models discovered from opencode
WS     /ws?runId=...                    live event stream
```

WebSocket event types: `round.status`, `agent.status`, `agent.tool`, `agent.tokens`, `round.scored`, `round.evolved`, `log`.

## 14. UI

- **Run setup** — goal, criteria, roster builder (model × count), seed directory picker, sandbox mode, selection ratios, concurrency, price table.
- **Arena** — live grid of agent cells (label, model badge, status, current tool call, elapsed, tokens, cost), leaderboard with rank deltas, round progress, cumulative cost.
- **Agent detail drawer** — strategy diff against previous round, notes diff, submission render, judge rationale, lineage path, per-round score history.
- **Between-rounds panel** — edit goal, review and edit criteria, add/remove agents, view `meta_digest`, "Run Round N+1".
- **Analytics** — fitness over time (mean, max, min), model share per round, strategy diversity metric, lineage tree.

## 15. Error handling

- **Agent failure is isolated.** Agents settle independently; one crash never blocks a round. Failed agents record `status` and score 0.
- **Timeouts.** Per-agent default 600s. On expiry, `session.abort`, `status = timeout`.
- **Provider errors.** Retry with exponential backoff on 429 and 5xx, max 3 attempts.
- **Judge failure.** Two retries, then fall back to batched mode. If that fails, the round is marked `failed` and no evolution is applied — the database is left unchanged so the user can retry judging without re-running the agents.
- **Malformed model JSON.** One repair attempt re-prompting with the parse error. Then: reflection carries the previous genome forward; judging fails the round.
- **Crash recovery.** On startup, rounds in non-terminal states are marked `failed`; workspaces are preserved. Containers are reconciled against the database by name and either adopted or recreated.

## 16. Testing

`MockSandbox` and `MockProvider` implement the same interfaces as the real ones, with seeded RNG, so the whole tournament loop runs offline, deterministically, at zero cost. This is a hard requirement, not a convenience: without it the evolution engine cannot be changed without spending money to discover whether it broke.

- **Unit** — selection math as property tests (population invariant, elite preserved, no orphaned lineage, bands partition the population); genome serialize/parse round-trip; strategy cap enforcement; criteria prompt assembly; cost calculation including the `pricing_missing` path.
- **Integration** — 6 agents × 5 rounds on mocks. `MockProvider` derives submission quality from a hidden fitness function of the strategy text, so a correct engine must show mean fitness at round 5 exceeding round 1. This test is what proves selection actually works.
- **Contract** — against a real opencode server, skipped absent credentials, asserting `session.create`, `prompt_async`, and `/event` payload shapes so SDK drift is caught.

## 17. Configuration reference

```ts
interface RunConfig {
  populationSize: number            // 20
  concurrency: number               // 8
  agentTimeoutMs: number            // 600_000
  sandbox: 'docker' | 'local' | 'mock'
  maxContainers: number             // 12 on this host, see §20
  containerMemory: string           // '512m'
  containerCpus: number             // 1
  seedDir: string | null
  roster: { modelId: string; count: number; temperature: number }[]
  judge: {
    modelId: string
    mode: 'auto' | 'single_call' | 'batched_finals'
    singleCallMaxPopulation: number // 25, the 'auto' threshold
    batchSize: number               // 5
    criteriaMode: 'auto' | 'user'
    submissionCharCap: number       // 6000
    anonymize: boolean              // true
  }
  reflect: {
    modelId: string
    topK: number                    // 5
    strategyCharCap: number         // 2000
    allowModelMutation: boolean     // true
  }
  selection: {
    eliteCount: number              // 1
    topPct: number                  // 0.2
    bottomPct: number               // 0.2
    crossoverPct: number            // 0
  }
  pricing: Record<string, { inPerM: number; outPerM: number }>
}
```

## 18. Build order

1. **Core loop on mocks** — `core/`, `db/`, `MockSandbox`, `MockProvider`, judge, evolution, round driver. Prove fitness climbs. No UI, no network, no Docker.
2. **Real OpenCode** — `LocalSandbox`, SDK integration, provider auth, model discovery.
3. **Docker sandbox** — image, container lifecycle, port allocation, reconciliation.
4. **Dashboard** — REST, WebSocket, React arena and controls.
5. **Analytics and polish** — lineage tree, diversity metric, crossover, model-share chart.

## 19. Known risks

| Risk | Mitigation |
|---|---|
| Homogenization: top-K visibility collapses diversity by ~round 5 | Track pairwise strategy distance; optional `diversityFloor` protecting the most distinct low performer from culling. Phase 5. |
| **Culling may be net-negative when improvement comes from imitation** | Measured during Phase 1 implementation, not theorized: on a fitness landscape where agents do not interact, disabling culling and elitism entirely produced a *higher* final mean (62.76) than normal selection (55.62). Culling removes a weak agent's distinctive strategy from the pool that reflection imitates, and that diversity loss can outweigh the benefit of freeing a slot. This is the homogenization risk above, arriving one round earlier than expected and through a different mechanism. Phase 2 should A/B `bottomPct: 0` against the default on a real goal before assuming culling helps. |
| Judge position and label bias | Anonymized refs, reshuffled each round. |
| Strategy bloat across generations | Hard character cap enforced at reflection. |
| Free Zen models rate-limiting at high concurrency | Concurrency knob, backoff, per-model retry accounting. |
| Docker volume performance on Windows | Keep workspaces small; document the WSL2 backend as the faster path. |
| Container memory at large populations | Sharding above `maxContainers`. |
| Goal changed mid-run makes cross-round fitness incomparable | Round records its own goal; the fitness chart segments at goal changes rather than drawing a continuous line. |

## 20. Verified environment (2026-08-22)

Facts below were confirmed empirically on the target host, not assumed.

**Runtimes.** Node 24.15.0, npm 11.12.1, Python 3.14.0, uv 0.8.22. OpenCode CLI 1.18.21
installed globally via npm (`opencode-ai@latest`); the OpenCode desktop app was already
present but ships no CLI, so the CLI was a required addition. Docker 29.5.3, daemon running.

**Authenticated gateways.** `opencode auth list` reports one credential: Weights & Biases.
No OpenCode Zen key is configured, yet 7 `opencode/*` models are available anyway — the Zen
free tier requires no credential. 36 models total are reachable right now:

- `opencode/*` free tier (7): `big-pickle`, `hy3-free`, `mimo-v2.5-free`,
  `muse-spark-1.2-contributor-free`, `nemotron-3-ultra-free`,
  `nemotron-3.5-lightning-free`, `x-preview-f-free`
- `wandb/*` (29), including `deepseek-ai/DeepSeek-V4-Flash`, `deepseek-ai/DeepSeek-V4-Pro`,
  `moonshotai/Kimi-K3`, `zai-org/GLM-5.2`, `MiniMaxAI/MiniMax-M3`,
  `Qwen/Qwen3-Coder-480B-A35B-Instruct`, `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B`

**Model IDs are fully qualified.** W&B models carry a vendor path segment
(`wandb/deepseek-ai/DeepSeek-V4-Flash`, not `wandb/DeepSeek-V4-Flash`). Any parser that
assumes a two-segment `provider/model` shape will break on these; treat everything after
the first `/` as an opaque model identifier.

**Tool use verified.** Both `opencode/muse-spark-1.2-contributor-free` and
`wandb/deepseek-ai/DeepSeek-V4-Flash` were given the submission contract from §8 via
`opencode run --dir <tmp> -m <model>` and both correctly wrote `SUBMISSION.md` with exact
contents. The core agent mechanism works on free inference.

**Docker memory ceiling: 7.18 GB.** This invalidates the original `maxContainers: 30` and
`-m 1g` defaults — 20 containers at a 1 GB cap would oversubscribe the host badly. Revised
defaults: `containerMemory: 512m`, `maxContainers: 12`. A 20-agent population therefore
shards across 12 containers by default on this machine rather than getting one container
each. Raising the Docker Desktop memory allocation is the lever if full per-agent isolation
at 20+ agents is wanted later.

**Cost consequence.** A 20-agent population drawn entirely from the Zen free tier costs
nothing to run, making long multi-round evolution experiments viable. The judge is the one
component where model strength materially affects outcome quality, since a noisy judge
produces noisy fitness and undermines selection; budget there first.
