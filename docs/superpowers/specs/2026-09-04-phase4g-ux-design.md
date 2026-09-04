# Phase 4g — Dashboard UX: grader feedback, model selection, setup clarity

Status: approved for planning
Direct response to operator feedback on the deployed app: (1) the judge's
feedback ("grader") and agent work summaries are unreachable beyond the latest
rationale — no per-round view exists; (2) models can't be meaningfully selected
— roster is a hand-typed textarea, judge/reflect models aren't settable at setup
at all (server supports them; web never sends them); (3) setup fields are
unexplained and the arena is bare.

## 1. Goal and non-goals

Every word the judge wrote and every submission is browsable per round; every
model slot (workers, judge, reflect) is picked — not typed blind — at setup;
every setup field explains itself.

In scope (§2–§6): 1 endpoint, 1 builder, 1 detail panel, 1 summary strip, setup
regroup, bounded arena polish.
Out of scope (stay out):
- Per-round judge-model provenance (rounds store `judge_mode` but not the model;
  PATCH can change it mid-run — reporting the CURRENT config's model per round
  would mislead. The detail shows `judgeMode` only; a `judge_model` rounds column
  is a migration for later, noted in §7).
- Markdown tables, run persistence across reload, stop-run changes, any redesign.
- Server-side changes beyond the one endpoint (all data already persists).

## 2. Verified facts (state of the world)

- Scores carry `rationale_md`, submissions carry `submission_md` + manifest +
  tokens/cost, rounds carry `goal_md`/`criteria_md`/`criteria_source`/
  `meta_digest`/`cost_usd`/`status`/`judge_mode`, genomes carry per-round
  `model_id` — the round-detail join needs NO new storage.
- `RunSpec.judge`/`reflect` partials exist server-side with defaults; web
  `FullRunSpec` does NOT include them (verified) — additive web-only gap.
- `parseRoster` (App.tsx) has NO test file and exactly one caller (verified) —
  safe to delete with the textarea.
- Known-models fetch (`listModels`) already exists web-side with graceful
  failure (4e); the roster textarea can't use a datalist per-line (4e ruling —
  the builder's per-row inputs CAN, one model per input).
- Snapshot (`RunSnapshot` + `busy`/`lastError` on GET) and round-stats
  (`fitness`/`costUsd` per round) already feed the client — the summary strip
  needs no new fetch.
- `<Markdown>` renderer exists (4d); diffs stay text (4d ruling).

## 3. API: `GET /api/runs/:runId/rounds/:idx` (round detail)

404 `'no such run'` / `'no such round'`. Response:
```
{ idx, goalMd, criteriaMd: string|null, criteriaSource: 'user'|'generated',
  metaDigest: string|null, costUsd, status, judgeMode: string,
  entries: [ { agentId, label, modelId, score, rank, band: string|null,
               rationaleMd,
               submission: { status, errorText, submissionMd, fileManifest,
                             costUsd, durationMs, tokens: {in,out,cacheRead,cacheWrite} } | null
             } ] }   // entries ASC by rank
```
Rules:
- Entries = scores-for-round joined with agent row (label), round-idx genome
  (`modelId`), submission-or-null — the same join shape as the agent-detail
  `history` entries (mirror that code, don't reinvent it; a shared private
  assembler is fine if it reads better).
- `judgeMode` straight from the round row. NO judge model (see §1 — honesty over
  completeness).
- Works for any round row regardless of status (scored or not — unscored rounds
  show entries `[]`... wait: scores only exist post-judge. For an unscored round
  return entries `[]` with the round header fields; do NOT 404 — the UI uses this
  to show "round in progress".
- Tests (inject): full shape on a seeded 2-round run (header fields incl.
  user-criteria round + generated round, entries rank-ordered with submission
  join + null-submission case); 404 run; 404 bad idx; unscored round → 200 with
  `entries: []`.

## 4. Web I: round detail + run summary (grader feedback access)

- `getRoundDetail(runId, idx)` in `web/src/api.ts` (file convention; type mirrors §3).
- **Round detail panel** (new section below Analytics, `RoundDetail.tsx`):
  round `<select>` over completed rounds (value = idx, default = latest; ALSO
  list the in-flight round when busy, showing its header + "scoring in progress");
  header block (goal, criteria + source badge, `meta_digest` via `<Markdown>`,
  cost, status); entries as cards/table rows ordered by rank: rank badge, label
  (+model badge), score, band; rationale in `<Markdown>`; submission in
  collapsible `<details>` (`<Markdown>` body, manifest file list, tokens/cost
  line, error block when non-ok).
- **Run summary strip** (top of arena, `RunSummary.tsx`, NO new fetch):
  run name + sandbox badge + status (busy/idle from existing state); rounds
  completed; best score + its round idx (from round-stats maxes — agent labels
  aren't in round-stats, so no agent name here); total cost (sum of round
  `costUsd`, `$X.XXXX`); "N agents active" (snapshot agents are `listActive`)
  beside the roster total (sum of configured counts).
- Both handle loading/error/empty with the file's existing conventions (one-line
  states, no new infra).

## 5. Web II: roster builder + model selection (replaces textarea)

- `RosterBuilder.tsx` (controlled: `value: RosterEntry[]`,
  `onChange`, `models: string[]`, `disabled`): rows of [model combobox | count |
  temp | remove]. Model input = text + `<datalist>` of known models (free text
  still valid — unknown ids pass through; server validates). Count = number ≥1
  int. Temp = number 0..2 step 0.1. Remove disabled when 1 row. Add-row button.
  Footer line: total agents + per-row inline errors (empty model, count < 1,
  temp out of range).
- Pure helper `web/src/lib/roster.ts`: `summarizeRoster(entries):
  { total: number; errors: string[] }` (per-row messages naming the row number)
  — unit-tested from the root suite (valid multi-row, empty model, zero count,
  temp out of range, total math). Component correctness via typecheck+build
  (no web harness — established pattern).
- App: DELETE `parseRoster` + `rosterText` state + textarea (verify no other
  caller first — one caller today); `handleCreate` uses builder output directly
  (client range re-checks stay: they now read the entries, same setup-error path).
- Judge/reflect pickers in RunSetup: judge model combobox (datalist) + mode
  `<select>` (auto/single_call/batched_finals, prefilled auto); reflect model
  combobox (prefilled `DEFAULT_CONFIG.reflect.modelId`). `FullRunSpec` gains
  `judge: { modelId: string|null, mode }` + `reflect: { modelId: string|null }`
  (null/empty = server default — App normalizes blanks to null; server partials
  already default-fill, verified pattern).
- Provenance check: `createRunFull` must actually SEND the new fields (read it —
  field-by-field vs spread — and extend accordingly; pinned per §7, not here).

## 6. Web III: setup regroup + arena polish (bounded)

- RunSetup sections with headings + one-line help each:
  **Run** (name, goal, criteria); **Population** (roster builder);
  **Models** (judge model+mode, reflect model — each with a "what is this for"
  line: judge scores submissions; reflect rewrites strategies);
  **Sandbox** (mode + paths + auth, keep existing help);
  **Advanced `<details>`** (selection 4, concurrency, pricing, budget display —
  each labeled in plain words: "Top band % (breeders)", "Bottom % (culled)",
  "Elites (kept verbatim)", "Crossover %", "Max parallel agents", "Price table").
- Arena: status line already partially exists — add the summary strip (§4) and a
  "No rounds yet — set a goal and run round 1" empty state; consistent
  `toFixed(2)` scores / `$X.XXXX` costs where newly rendered (don't churn
  untouched components).
- Explicitly NOT a redesign: same theme, same layout order (setup → arena →
  analytics → round detail), no new CSS framework, styles follow `styles.css`
  conventions.

## 7. Testing + gate + follow-ups noted

- **Unit (root):** roster helper (valid/errors/total); round-detail assembler is
  server code — covered by inject below.
- **API (inject):** §3 full shape + 404s + unscored-round shape.
- **E2E (append-only):** round detail on the mock run (header + rank-ordered
  entries + rationale present); create-with-judge/reflect-models → stored config
  carries them (read back via... the stored config isn't directly readable —
  pin via PATCH-round-trip? NO: pin via the 4e pattern — create with
  `judge.modelId` + assert the FIRST round's behavior? Simplest honest pin:
  create 201 + GET rounds entry exists after a round + the mock judge ran
  (already covered). Hmm — actually the e2e CAN read stored config: legacy
  PATCH `GET`? No GET-config endpoint exists. DECISION: e2e asserts 201 with the
  new fields accepted (no 400) + unit tests pin the merge in runConfigFor via a
  direct `runConfigFor(spec-with-judge)` assertion in a server unit test
  (import the pure function — allowed, it's already exported). Document this
  split in the plan.
- **Gate every task:** `npm test`, `typecheck`, `web:build`.
- Follow-ups noted (do NOT build): rounds `judge_model` column (migration);
  dashboard floor toggle / CLI selection flags (4f rec.4, still optional).

## 8. Spec coverage map

- Grader feedback access → §3 endpoint + §4 detail panel (rationales, submissions,
  meta_digest, criteria per round) + summary strip.
- Model selection → §5 builder (workers, discoverable) + judge/reflect pickers.
- Setup clarity → §6 regroup + help + §5 validation.
- §7 tests → per-item above, gate on every task.