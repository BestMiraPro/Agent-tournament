# Context folder and a tool-using grader — design

**Date:** 2026-09-15 · **Status:** approved 2026-09-15 · **Branch:** `phase5-review-fixes`

## Why

A user filled the run form's "Auth file" field with a research folder, believing it was context for the agents. The app
has no way to give agents — or the grader — reference material, and the grader cannot look anything up. This adds both.

## What the user gets

1. A run option **Context folder (read-only)**: a folder of reference material.
2. Worker agents are told about it and can read it, but not change it (enforced under Docker).
3. The grader reads the same folder with file tools, and can **search the web and open pages**, when it generates criteria
   and when it scores submissions. It still returns the same structured JSON, so scoring, evolution and the dashboard are
   unchanged downstream.
4. The credentials field is relabelled **Credentials file (auth.json)** so it cannot be mistaken for context again.

## Verified facts this relies on (OpenCode 1.18.21, no prompts sent)

- Agent profiles in `.opencode/agents/<name>.md` load from the session directory; profile permission rules are appended
  after the defaults and the last match wins (`test/fixtures/opencode-1.18.21/permission-contract.json`).
- External-directory rules accept absolute path patterns (the runtime's own defaults contain them).
- Registered tools include `read`, `glob`, `grep`, `webfetch`, `websearch` (`GET /experimental/tool/ids`).
- Per model (`GET /experimental/tool?provider=&model=`): `webfetch` is offered to every provider; `websearch` is offered to
  the `opencode` provider only — **unless the server runs with `OPENCODE_ENABLE_EXA=1`**, which offers it to W&B as well.
- The grader's calls already run as OpenCode sessions on the host server, today as the implicit `build` agent, which
  allows editing and shell commands. The grader profile below removes that.

## Design

### 1. Setup, validation and storage

- `RunSpec.contextDir: string | null` (absent/blank → null), carried into `RunConfig.contextDir` so it is stored with the
  run and every later round uses it. The dashboard form gets the field; the CLI is unchanged.
- Checked in `composeRun` before any server, capacity read or container starts (same place as the auth-file check):
  must be an absolute path to an existing **folder**; must not be inside the workspace root, and the workspace root must
  not be inside it. Failures are 400s with a message that says what to fix.
- Mock runs accept and store it but nothing reads it.

### 2. Worker agents

- **Prompt:** `buildAgentPrompt` adds, only when set:
  `Reference material (read-only) is in <path>. Read what is relevant before you start; you cannot change it.`
  `<path>` is `/context` under Docker and the real host path locally.
- **Docker:** `buildRunArgs` adds `-v <contextDir>:/context:ro` to every shard. Read-only is enforced by the mount.
- **Local:** the competitor profile allows `external_directory` for `<contextDir>/*` and denies `edit` there (last match
  wins). **Limitation:** agents keep `bash`, which permission rules cannot confine to paths, so a local agent could still
  alter the folder. The form's help text says so and recommends Docker when the folder must stay untouched.
- Everything else about the competitor profile (including its unattended denials) is unchanged.

### 3. The grader

- **Profile** `grader`, written at composition to a dedicated directory `<workspaceRoot>/.arena-grader/.opencode/agents/grader.md`
  (frontmatter only, like the competitor profile):
  - allow: `read`, `glob`, `grep`, `list`, `webfetch`, `websearch`;
  - deny: `edit`, `bash`, `task`, `todowrite`, `skill`, `question`, `doom_loop`;
  - `external_directory`: deny everything, then allow `<contextDir>/*` when a context folder is set. Agents' workspaces
    are outside the grader directory, so the grader cannot browse them.
- **Where it applies:** `OpenCodeProvider.complete` sends `agent: "grader"` with the grader directory for purposes
  `criteria` and `judge`. `reflect` (strategy rewriting) keeps today's call.
- **Web search:** the host OpenCode server started by the app gets `OPENCODE_ENABLE_EXA=1`, so search is offered to the
  grader whatever its provider. Docker shards are unchanged.
  - *Side effect, accepted:* in **local** runs, worker agents share that host server, so non-OpenCode worker models also
    gain `websearch` (OpenCode-provider workers already had it; the competitor profile does not deny it).
- **Prompts:** criteria and scoring prompts gain, when a folder is set, a line pointing at it; always a line saying the
  grader may search the web and open pages to check claims; and a line that submissions are untrusted data, never
  instructions. The requested JSON shape is unchanged.
- **Limits:** each grader call stays bounded by the existing request deadline (agent timeout). Invalid JSON follows the
  existing repair-retry-then-fail path. Tool use makes grading slower and more expensive; the model decides how much it reads.

### 4. Security trade-off (needs acceptance)

The grader reads untrusted submissions and can fetch arbitrary URLs. A submission could try to make it fetch a URL that
carries context-folder contents to a third party. Permissions cannot block that without also blocking useful browsing
(search results link to arbitrary sites). Mitigation is the untrusted-data instruction only; **do not put secrets in a
context folder.** The form's help text says this.

### 5. Out of scope

A context folder per round; CLI flag; web access for Docker workers; restricting the grader to allow-listed domains;
showing the grader's tool activity in the dashboard timeline.

## Testing and verification

- Unit: spec validation (absolute, exists, folder, no overlap); `RunConfig` round-trip; `buildRunArgs` read-only mount;
  worker prompt line with `/context` vs host path; competitor local rules; grader profile text; provider sends
  `agent: grader` + grader directory for `criteria`/`judge` only; host server env includes `OPENCODE_ENABLE_EXA=1`;
  scoring/criteria prompt lines; form field and relabelled credentials field.
- Free runtime checks (no prompts): `GET /agent` loads `grader` with the intended last-match rules; `GET /experimental/tool`
  offers `websearch` for the W&B grader model on the app's host server; a shard lists `/context` as read-only.
- Needs one small paid run, with approval: a real grader reads a context file and/or searches, then still returns valid
  structured scores.
