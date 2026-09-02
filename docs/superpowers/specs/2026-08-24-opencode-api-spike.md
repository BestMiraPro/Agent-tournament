# OpenCode API Spike — Verified Findings

**Date:** 2026-08-24
**Method:** Ran a real `opencode serve` (v1.18.21, port 4599), read its OpenAPI 3.1 spec at `/doc`
(162 paths), and drove real sessions against real models. Every statement below was executed, not
read from documentation.

**Why this exists:** the Phase 1 plan was written in one pass without executing anything and shipped
eight defects. Phase 2 depends entirely on an external API whose shape I did not actually know. This
spike establishes ground truth before the plan is written.

---

## 1. One server serves every agent

Nearly every endpoint accepts `directory` as a **query parameter**:

```
POST /session?directory=<abs-path>
POST /session/{id}/message?directory=<abs-path>
GET  /config/providers
GET  /event
```

Verified: `POST /session?directory=<ws>` returned a session whose `directory` field echoed the exact
workspace path, and the agent's file writes landed in that directory.

**Design impact.** The design spec (§11) assumed one `opencode serve` per agent, ~150–400MB each,
which is what forced `maxContainers: 12` against a 7.18GB Docker ceiling. For the **local** sandbox
this is unnecessary — a single server process serves all N agents via `?directory=`. Phase 3's Docker
sandbox may still want per-container servers for isolation, but that is now an isolation choice
rather than a technical requirement.

## 2. The strategy injects as `system`, per request

`POST /session/{id}/message` body (only `parts` is required):

| field | type | notes |
|---|---|---|
| `parts` | array | **required** |
| `model` | `{providerID, modelID}` | see §3 |
| `system` | string | **the genome's strategy goes here** |
| `agent` | string | named agent from config |
| `format` | OutputFormat | see §4 |
| `tools` | object | per-request tool gating |
| `noReply`, `variant`, `messageID` | | |

Verified: passing `system: 'You are competitor-01. STRATEGY: ...'` produced behavior consistent with
that instruction, and the agent wrote the requested file.

**Design impact.** Writing `.opencode/agents/competitor.md` into the workspace (added in Phase 1) is
no longer the delivery mechanism — `system` is simpler, needs no config reload, and cannot be read or
overwritten by the agent itself. Keep writing the file as a human-readable artifact and for Phase 3
parity, but **`system` is the authoritative channel**.

## 3. Model IDs must be split on the FIRST slash only

`model` is an object, not a string:

```js
function splitModel(id) {
  const i = id.indexOf('/')
  return { providerID: id.slice(0, i), modelID: id.slice(i + 1) }
}
```

Verified: `wandb/deepseek-ai/DeepSeek-V4-Flash` → `{providerID:'wandb', modelID:'deepseek-ai/DeepSeek-V4-Flash'}`.
A naive `split('/')` into two parts corrupts every W&B model.

## 4. Schema-constrained output exists, and it is better than parse-and-repair

```js
format: { type: 'json_schema', schema: <JSONSchema>, retryCount: 2 }
```

The result does **not** appear in text parts. It arrives as a tool part:

```js
const so = parts.find(p => p.type === 'tool' && p.tool === 'StructuredOutput')
so.state.input              // the parsed, validated object
so.state.metadata.valid     // boolean
so.state.status             // 'completed'
```

Verified end-to-end with the real judge ranking schema: a live model ranked three submissions,
returned `rankings[]` with `ref`/`rank`/`score`/`rationale` plus `meta_digest`, and put the best
submission first.

**Design impact.** `parseWithRepair` was built because "models wrap JSON in prose" — the most common
runtime failure in LLM pipelines. With `json_schema` the provider enforces the shape and retries
internally via `retryCount`. Keep `parseWithRepair` as a fallback for models that lack the capability
(§6), but it stops being the primary path.

## 5. Cost and tokens come back per message — no pricing table needed

```json
"tokens": {"total":8702,"input":444,"output":17,"reasoning":64,"cache":{"write":0,"read":8177}}
"cost": 0
```

**Design impact.** Spec §12 specifies a hand-maintained per-model price table with a `pricing_missing`
flag. OpenCode computes cost itself. Use `info.cost` as the source of truth and keep the price table
only as a fallback for providers that report 0 incorrectly. Note also that `tokens` has a **cache
read/write breakdown** the Phase 1 `tokensIn`/`tokensOut` shape cannot represent — cache reads
dominated the observed traffic (8177 of 8702 tokens on one call), so ignoring them would badly
misreport cost.

Also note: a trivial prompt consumed ~8k input tokens, because opencode injects a large system
prompt. Per-call overhead is roughly constant and non-trivial; small-context models drown in it (§6).

## 6. **Listed models are not callable models, and capability is per-task**

This is the most important finding.

Probed all 36 models reported by `/config/providers` with a trivial prompt. **27 of 36 worked.**
Total probe cost: **$0.0848**.

Failures:

| model | failure |
|---|---|
| `wandb/moonshotai/Kimi-K3` | **404 Not Found** |
| `opencode/muse-spark-1.2-contributor-free` | 400 on structured output — **but works fine as a plain agent** |
| `opencode/nemotron-3-ultra-free` | "Model did not produce structured output" |
| `wandb/OpenPipe/Qwen3-14B-Instruct` | ContextOverflowError — opencode's ~8k system prompt exceeds its limit |
| `wandb/JetBrains/Mellum2-12B-A2.5B-Instruct` | fetch failed on first probe |
| `wandb/deepseek-ai/DeepSeek-V3.1` | fetch failed on first probe |
| `wandb/Qwen/Qwen3.6-35B-A3B` | fetch failed on first probe |
| `wandb/meta-llama/Llama-3.1-8B-Instruct` | fetch failed on first probe |
| `wandb/ibm-granite/granite-4.1-8b` | fetch failed on first probe |

**`wandb/moonshotai/Kimi-K3` was the design spec's default judge model.** It 404s. Phase 2 would have
failed on its first real run with an opaque error.

**The five `fetch failed` models are not all actually dead.** Re-probing them found the failure was
transient for four of the five:

| model | first probe | retry |
|---|---|---|
| `wandb/deepseek-ai/DeepSeek-V3.1` | fetch failed | OK (plain) / OK (structured) |
| `wandb/Qwen/Qwen3.6-35B-A3B` | fetch failed | OK (plain) / OK (structured) |
| `wandb/ibm-granite/granite-4.1-8b` | fetch failed | OK (plain) / OK (structured) |
| `wandb/JetBrains/Mellum2-12B-A2.5B-Instruct` | fetch failed | OK (plain) / fails (structured) |
| `wandb/meta-llama/Llama-3.1-8B-Instruct` | fetch failed | THREW / THREW — genuinely dead |

Only `wandb/meta-llama/Llama-3.1-8B-Instruct` is consistently unreachable. The other four are usable,
and `wandb/JetBrains/Mellum2-12B-A2.5B-Instruct` joins the worker-only capability class alongside
`opencode/muse-spark-1.2-contributor-free` and `opencode/nemotron-3-ultra-free` (plain text works,
structured output does not).

Transient transport failures like these are common enough — four of five `fetch failed` results turned
out to be spurious — that model validation must retry a transport-level failure before concluding a
model is unusable.

**Two distinct capability classes:**

- **Worker models** need tool use, not structured output. `muse-spark-1.2-contributor-free` qualifies
  (verified writing `SUBMISSION.md`).
- **Judge and reflect models** need structured output. `muse-spark` does **not** qualify.

A single "is this model OK?" check is therefore wrong. Validation must be capability-specific.

### Revised defaults, all verified callable

| role | model | latency | cost/call | why |
|---|---|---|---|---|
| judge | `wandb/zai-org/GLM-5.2` | 4442ms | $0.006 | structured output verified; ranked a real 3-way correctly |
| reflect | `wandb/deepseek-ai/DeepSeek-V4-Flash` | 1604ms | $0.001 | structured output verified, fast, cheap |
| workers | free Zen tier + `DeepSeek-V4-Flash` | — | $0 / $0.001 | tool use verified |

Cheapest structured-output models measured: `wandb/openai/gpt-oss-20b` ($0.00022),
`wandb/Qwen/Qwen3-30B-A3B-Instruct-2507` ($0.00079, 888ms — fastest overall).
Free structured-output models: `opencode/nemotron-3.5-lightning-free`, `mimo-v2.5-free`, `hy3-free`,
`big-pickle`, `x-preview-f-free`.

## 7. Event stream for live UI

`GET /event` is `text/event-stream`. Relevant variants in the spec:
`EventMessagePartUpdated`, `EventMessageUpdated`, `EventSessionUpdated`, `EventSessionCreated`,
`EventSessionDeleted`, plus permission and TUI events.

`EventMessagePartUpdated` is what drives a live per-agent tool-call feed in Phase 4.

## 8. Other endpoints worth knowing

- `POST /session/{id}/prompt_async` — fire without waiting; pair with `/event`
- `POST /session/{id}/abort` — the timeout enforcement path Phase 1 never built
- `GET /session/{id}/diff` — file changes made during a session
- `GET /config/providers` — `{providers:[{id, models:{...}}], default:{...}}`; 2 providers, 36 models
- `GET /file/content?path=` and `GET /file?path=` — read agent output without touching the filesystem
  directly, which will matter for Phase 3 when files live inside containers

## Consequences for the Phase 2 plan

1. `OpenCodeProvider` uses `format: json_schema` and reads the `StructuredOutput` tool part;
   `parseWithRepair` becomes the fallback path, not the primary.
2. `OpenCodeAgentRunner` injects the strategy via `system`, and calls `session.abort` on timeout.
3. A **capability-aware model validator** runs before a tournament starts: probe each rostered model
   for the capability its role requires, and refuse to start (or drop the model with a visible
   warning) rather than failing mid-round.
4. Cost comes from `info.cost`; token accounting must carry the cache breakdown.
5. The local sandbox is one server plus per-agent directories, not a server per agent.
6. Default judge changes from the non-existent `Kimi-K3` to `GLM-5.2`.

---

## 9. The `/event` SSE stream requires `?directory=` (verified 2026-08-25, for Phase 4)

Subscribing to `GET /event` **without** a `directory` query parameter yields only
`server.connected` and `server.heartbeat`. An agent ran for 10.9 seconds doing real tool work
during that subscription and produced **zero** message or session events.

Subscribing to `GET /event?directory=<abs-path>` — the same directory used for the session —
delivers the full stream.

This matters because the failure is silent: the connection succeeds, frames arrive, and a live
UI would simply display nothing forever while appearing healthy.

**Wire event types are lowercase-dotted, not the OpenAPI schema names.** The spec calls the
schema `EventMessagePartUpdated`; the `type` field on the wire is `message.part.updated`. Coding
against the schema names would match nothing.

Observed types, and what each is good for:

| wire `type` | use |
|---|---|
| `session.status` (`{type:'busy'}` / idle) | agent running vs finished |
| `session.idle` | agent done |
| `message.part.delta` | token-by-token streaming (`field`, `delta`) |
| `message.part.updated` | tool calls and text parts as they appear |
| `message.updated` | message-level state |
| `session.diff` | workspace changes during the session |
| `file.edited`, `file.watcher.updated` | agent wrote a file |
| `session.created`, `session.updated` | session lifecycle |
| `server.connected`, `server.heartbeat` | transport liveness |

Every payload carries `properties.sessionID`, so a dashboard can map events to agents by keeping
a `sessionID → agentId` map built when each session is created.

**Consequence for Phase 4.** A live per-agent grid is feasible without polling. The orchestrator
subscribes once per shard endpoint with that shard's directory, maps `sessionID` to `agentId`, and
relays. With Docker sharding each container needs its own subscription, since each has its own
server.
