# Collaboration mode — design

**Date:** 2026-11-15 · **Branch:** `phase8-collaboration-mode` · **Status:** implemented on this branch

## What the owner asked for (decided)

- A new workflow, **collaboration**, becomes the app's default: `DEFAULT_CONFIG`, the dashboard's Create-run form and the CLI. The evolutionary workflow keeps working unchanged as **tournament**.
- Agents in one round talk to each other directly through a markdown file.
- No automatic cloning or deletion: no clone, cull, crossover, diversity-floor rescue or elites. The population changes only through the existing manual controls between rounds.
- The team works in **one shared container** instead of one each.
- The team co-writes an **output folder** holding everything it built (code, data, notebooks, docs). That folder is judged as one team artifact.
- **The shared workspace carries over between rounds.** The team keeps building on its own work, a research program rather than a fresh start each round. Each round's `output/` and `CHANNEL.md` are snapshotted and sealed for judging, export and the dashboard. This is settled, not an open option.

## Configuration

`RunConfig.workflow: 'collaboration' | 'tournament'`. Not `mode`: the CLI's `--mode` already means mock/real, so the CLI flag is `--workflow`.

- `DEFAULT_CONFIG.workflow` is `collaboration`.
- A stored config without the field decodes as `tournament` (`decodeConfig` in `src/db/repos.ts`), because that is what every older run ran as. Same precedent as `isolation` decoding as `shared`.
- The workflow is fixed at creation. `PATCH /config` cannot change it: half a run judged as individuals and half as a team would make its history incomparable.
- `DEFAULT_TEAM_SIZE = 4` (`src/core/types.ts`), derived from the measured figures in the `DEFAULT_CONFIG` comment and `2026-09-16-container-sizing-benchmark.md`. A team container is charged one agent's ceiling (`containerMemory`, 1g) per member plus one 64m gateway. On the reference host's ~5.2 GiB of free Docker memory the preflight commits at most 80%, about 4.16 GiB: four members (4 GiB + 64 MiB) fit, five (5 GiB + 64 MiB) do not. One OpenCode server serves the whole team, so the measured per-container peak (~413 MiB short tasks, ~725-762 MiB in 100-turn conversations, each including its own ~250 MiB server) over-counts a shared container. Four members therefore keep real margin. The tournament population default (20) stays as it is for tournament runs. The CLI and the setup form default to four agents for collaboration.

Run spec (`src/server/run-spec.ts`): `workflow` is optional and defaults to `collaboration`. For collaboration:

- selection settings are accepted and ignored (the elite-vs-top-band rule only applies to tournaments);
- the protected "one container per agent" rule does not apply, since the team shares one container by design;
- docker with `isolation: 'shared'` is refused. A collaboration container always uses the protected runtime (below).

## Shared workspace

One per run, persisting across rounds:

```
team-<runId>/            local: <workspaceRoot>/team-<runId>; docker: the same host folder mounted at /work
  output/                the team deliverable: the judged artifact; entry point output/README.md
  CHANNEL.md             the message board
  agents/<label>/        optional per-agent scratch; NOTES.md is the agent's notes from reflection
  GOAL.md                rewritten every round
  .opencode/agents/member-<label>.md   each agent's OpenCode profile (model, temperature, permissions)
  .opencode/arena/post.mjs             the channel helper
```

- The workspace is seeded from `seedDir` only when it is first created. A later round never re-copies the seed over the team's edits.
- Each agent's strategy still arrives through the prompt's `system` field, so teammates cannot read or overwrite each other's strategy. Profiles are per agent (`member-<label>`) because one shared `competitor.md` cannot carry several models and temperatures.
- Sandboxes gain one optional method, `provisionTeam(teamId, agentIds, opts) → { handles, created }`. Every handle points at the shared workspace. A sandbox without it cannot run a collaboration round, and the round is refused before anything is written.
- Workspace caps scale with the team: `maxWorkspaceBytes × members` and `maxWorkspaceFiles × members`, the same total disk a tournament of that size could hold in private workspaces. Seeded files still at their seeded size do not count. A team over the cap gets an `error` team result with the reason, exactly as an agent over its cap does in a tournament.

## Channel (direct communication)

Entry format (one per post, append-only):

```
### agent-02 · 2026-11-15T10:00:05.123Z
body

### agent-03 · 2026-11-15T10:01:00.000Z → @agent-02
body
```

**Helper.** `node <workspace>/.opencode/arena/post.mjs <label> [@label] <message…>`, or the message on stdin. It takes a lock (`mkdir CHANNEL.md.lock`, with a bounded wait and stale-lock break), appends the whole entry in one `O_APPEND` write, and releases the lock. Body lines that look like an entry header are escaped, so a post cannot forge another entry. Agents are told never to edit `CHANNEL.md` with editors.

*Deviation from the brief's example (read-only tools mount).* The helper lives under the workspace's `.opencode/`, which the engine already uses for runtime plumbing. It is excluded from manifests and quotas, and the engine rewrites it every round. This works the same in local, docker and mock mode, and local mode has no read-only tools mount. An agent could edit it, but it could just as well edit `CHANNEL.md` directly, so a read-only helper would protect nothing. The engine treats the file as untrusted text either way. Labels are self-declared (no per-session identity exists inside one shared OpenCode server). That is acceptable because teammates are not ranked against each other, so nothing rewards impersonation.

**Delivery.** The engine tails `CHANNEL.md` through the sandbox while agents run (every 2 s; the mock composition polls faster). Each new entry from a teammate is queued into every other live agent's session through `AgentRunner.send(handle, text)`, an optional runner method so the Claude Code runner being built in parallel can implement it too. OpenCode implements it with `prompt_async`, the steering path: the message waits behind the agent's current step. `@label` entries go only to that agent. Every entry stays in the file.

Bounds, so a chatty agent cannot flood its teammates or the token budget:

- per entry, at most 2,000 characters delivered (longer posts are cut, with a pointer to `CHANNEL.md`);
- per delivery, at most 6,000 characters. New entries for one recipient within a poll are coalesced into one message;
- per recipient, at least 15 s between deliveries. Entries arriving inside the gap join the next delivery;
- per recipient per round, at most 30 deliveries. The 30th says delivery has stopped and the file is the place to read;
- agents that finished, failed or were stopped receive nothing (no wake-up of a stopped session).

The engine reads at most 1 MiB of `CHANNEL.md` per poll. Entries are identified by their header, so editing an old entry's body does not redeliver it. Entries already present when a round starts belong to earlier rounds and are neither redelivered nor persisted again. The engine writes a `## Round N` line (not an entry) at the start of each round.

**Persistence and live view.** New entries are stored per round in `channel_messages` (author, target, time, body, who it was delivered to) and broadcast as `channel.message` events over the existing WebSocket bridge. The dashboard's live view shows them in a channel panel.

## Shared container (Docker)

- `DockerSandbox` places a collaboration team on **one** container (shard 0), whatever `maxContainers` says, with the team workspace mounted at `/work`.
- It always uses the protected runtime: no credentials inside, the shard's internal-only network, a gateway plus the host provider relay, `--cap-drop ALL`, `no-new-privileges`, read-only root, unprivileged user 1000. `shared` isolation's auth.json mount and ordinary network are never used.
- Limits scale with team size N: memory `containerMemory × N`, CPUs `containerCpus × N`, PIDs `256 × N`, open files `2048 × N`. The gateway keeps its own fixed limits.
- Capacity preflight: one container of the scaled size plus its gateway, through the same ledger. A refusal names the team size, the scaled ceiling and the largest team that would fit.
- Containers are still recycled between rounds (fresh OpenCode server each round). Only the workspace carries over.
- Local sandbox: one shared directory. Mock sandbox: one shared in-memory workspace per team, kept for the life of the sandbox.

## A collaboration round

`TournamentEngine.runRound` shares the preflight, round row, criteria and failure handling with tournaments, then branches into `src/engine/collaboration.ts`:

1. **Prepare.** Resolve each active agent's genome (same carry-forward rule). `provisionTeam`. Write `GOAL.md`, profiles, per-agent `NOTES.md`, the helper and the round header. Read the existing channel so old entries are marked seen.
2. **Run.** Every active agent is dispatched at once: a team that cannot run simultaneously cannot talk. `concurrency` applies to tournaments only. Each agent's `AgentRunContext.team` carries its label, its teammates' labels and the post command. The runner builds the collaboration prompt: who the teammates are, the channel protocol, that `output/` is the judged deliverable and needs `output/README.md` explaining what was built and how to run or read it. The steering message at `agentSteerAfterMs` tells the agent to finish its part of `output/` and the README. Budget gate, timeout race and quiesce work as in tournaments. The tailer delivers channel entries. A runner in a team context does not look for `SUBMISSION.md`.
3. **Barrier and capture.** Once the pool has drained and every agent has been quiesced, the tailer stops and one last read persists the remaining entries. `output/` and `CHANNEL.md` are captured once. Files are hashed within the team budget, text content up to 256 KiB per file and 8 MiB per round is stored, and binary files (NUL or invalid UTF-8) are listed with size and hash only. A digest over the manifest and the channel seals the capture. `sealed` is true only when every agent was confirmed stopped. Nothing else can write a team workspace, so per-agent tamper detection is replaced by this one round-wide seal. The snapshot goes to `round_outputs` and `round_output_files`.
4. **Freeze.** Each member gets a `submission.captured` event carrying the team capture's seal, so the frozen audit's integrity records describe the team snapshot. The audit is frozen. Per-agent **contribution evidence** comes from the frozen records (file edits and write/edit/patch tool calls under the workspace) plus each agent's channel posts. It is stored with the snapshot. Workers are released.
5. **Judge.** `Judge.scoreTeam` grades the sealed artifact as one submission against goal and criteria. When the composition can materialise the sealed copy (local and docker), it is written under the grader's own session directory (`.arena-grader/sealed/<roundId>/`), and the prompt tells the grader to read `README.md` and the manifest first, then open files with its read-only tools. Without one (mock), README and text excerpts are inlined. Members' frozen activity is shown per member (`M1`, `M2`, …). Cited evidence is checked against what was shown. Blind/shuffle logic does not apply to one artifact and is skipped. The decision record is the same envelope as today: criteria, assessments, limitations, safety, evaluator model, prompt version. Every member's entry holds the team assessment. A team with nothing to grade (empty `output/`, over quota, or every agent failed without output) is not judged and scores 0, and its members' behaviour is still reviewed.
6. **Scores.** One team score per round in `team_scores`. It is mirrored into each member's `scores` row (rank 1, no band) so per-agent history, analytics, CSV and the CLI keep working without special cases.
7. **Reflect.** No selection, breeding or retirement. Unless the budget was breached, each agent's strategy is rewritten (`Reflector.reflectTeam`) from the team score, the judge's rationale and meta digest, that agent's own channel posts and its contribution evidence. The rewrite is stored as next round's genome (`mutation`). Without a rewrite it carries forward unchanged (`clone`). Lineage is kept and agents are never deleted.

Abort, budget and failure semantics are the tournament's: the round fails at its next gate, and reflection is skipped on a breach.

## API, export and dashboard

- `GET /api/runs/:id` snapshot: `workflow`.
- `GET /api/runs/:runId/rounds/:idx`: `team` (score, rationale, status) for collaboration rounds.
- `GET /api/runs/:runId/rounds/:idx/output`: capture metadata, manifest, contributions.
- `GET /api/runs/:runId/rounds/:idx/output/file?path=…`: one sealed file (content null for binary or unstored files).
- `GET /api/runs/:runId/rounds/:idx/channel`: the round's channel entries.
- `POST /rounds/:idx/rejudge` on a collaboration round regrades the sealed artifact, non-destructively as before.
- JSON export: each collaboration round adds `team` (score, output manifest and capture, contributions, channel).
- Dashboard: workflow selector in Create run, collaboration preselected. Selection and breeding knobs, Containers and Isolation are hidden for collaboration. The live view has a channel panel, an output-folder browser (list and view files of a round's sealed output) and the team score per round. Tournament runs render exactly as before.

## Known limits

- The seed sizes behind the quota exemption are taken when the workspace is created and kept in the engine's memory. After the dashboard restarts mid-run, seeded files count against the team quota like any other file.
- Local runs keep one OpenCode server for the whole run. If that server read the shared folder's profiles before a member added between rounds had its `member-<label>.md`, the new member may not find its profile. Docker runs start a fresh server every round and are not affected.
- Labels in the channel are self-declared (see above). Contribution evidence shows only what the activity stream observed: files written by a program inside a shell command are not attributed.
- Text is captured as the sandbox decodes it (UTF-8), the same as tournament capture. Binary files are listed and hashed, never stored or shown.

## Not in scope

Connectors, subscription runs and web search are separate branches. A Claude Code runner must implement `send()` to receive channel messages and read `AgentRunContext.team` for the collaboration prompt.
