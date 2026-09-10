# Review implementation progress

Main handoff: [2026-09-06-code-review-and-implementation-handoff.md](2026-09-06-code-review-and-implementation-handoff.md).

## Resume here

- Started 2026-09-07. Branch: `phase5-review-fixes` in the normal project checkout.
- Base: `de7a431845c86ba0705aafc43d59aa220730ac69`.
- Source/test tree was clean at start. Review document was untracked and must be preserved.
- User: implement the handoff, save usage, do expensive tasks last, keep work easy for another agent to resume.
- Detailed local ledger and task artifacts: `.superpowers/sdd/review-fixes/` (gitignored; do not commit).
- Do not rerun the whole review. Read this progress file, then the active task brief/report and `git status`.
- Full baseline previously: 809 passed, 3 gated skips. Run focused tests during work; all three AGENTS gates are required at integration before claiming completion.
- The third expected skip is `test/e2e/dashboard-real.test.ts` (`ARENA_DASHBOARD_E2E=1`), alongside local and Docker real-mode suites. AGENTS.md still quotes the older 767/2 baseline; refresh its counts/skip list at final integration, preserving all three gates.
- No paid provider runs, dependency upgrades, or broad visual redesign have been performed.
- Latest verified checkpoint: `e10cd91` (B16), after `8836535` (Task 10 review fixes) and `e0a49cd` (B17/B18). Full gates at `e10cd91`: 922 passed / 11 skipped; typecheck/build/diffcheck exit 0.
- Active: nothing. All confirmed bugs B01-B20 are complete. Remaining work is the I01-I14 / U01-U08 investigations and optional improvements, which need scope confirmation first, plus the unexecuted validation listed below.
- Expected skips are now 11, not 3: the three gated real-mode/e2e suites plus eight file-symlink tests that need SeCreateSymbolicLink (this account gets EPERM; junction coverage runs). AGENTS.md still quotes 767/2 and must be refreshed to 922/11 with this skip list.

## Ticket status

| Tickets | Status | Evidence / next action |
| --- | --- | --- |
| B01 | Complete | Commit `7db9c51`; API tests 39 pass; scoped review and typecheck follow-up passed; included in full 836-test gate. |
| B02–B03 | Complete | Commit `bbe2a0e`; scoped review approved and full 853-test gate passed. Browser-only keyboard/recovery checks still pending. |
| B04–B06 | Complete | Commit `1c01ffa`; 57 focused tests pass; scoped review fix approved; included in full 836-test gate. |
| B07 | Complete | Commit `9774e1f`; RED 3 regressions; GREEN 48 driver tests; scoped review and full 842-test gate passed. |
| B08 | Complete | Commit `3ed6bd6`; 58 focused tests; scoped review, typecheck and full 842-test gate passed. |
| B09–B11 | Complete | Commit `bbe2a0e`; 46 focused tests, three review fix rounds, full 853-test gate. Real-browser lifecycle acceptance still pending. |
| B12–B14 | Complete | Commit `34d705d`; scoped re-review approved; final870-test gate passes. Both test review findings corrected; real-mode acceptance pending. |
| B15 | Complete | Commit `bc0718c`; fix round 1 landed the once-per-round admission check. 118 focused tests; both cross-round regressions shown to fail without the guard; full 884-test gate passed. |
| B16 | Complete | Commit `e10cd91`; shared `resolveInWorkspace` anchored at the sandbox root. Live junction reproduction: removing the walk returns the sibling fixture's contents. 17 focused pass / 8 EPERM skips; full 922-test gate. |
| B17–B18 | Complete | Commits `e0a49cd` + `8836535` (all three review findings). 31 focused tests; each fix shown to fail when reverted; full 922-test gate. Windows only — POSIX termination unvalidated. |
| B19 | Complete | Commit `2898bca`;95 focused tests, scoped review/full859-test gate passed. Server rejects overrides from judging onward. |
| B20 | Complete | Commit `bec120b`;31 focused tests including rendered summary; scoped review and full857-test gate pass. Browser layout check pending. |
| I01–I14, U01–U08 | Not started | Investigations/optional improvements; confirm scope and trigger first. |
| Full test/typecheck/build; browser; optional real-mode | Pending | Integrated gates last. Real provider use is not automatically authorized. |

## Working decisions

- Use a dedicated branch in the existing checkout to keep the project easy to resume and avoid duplicating dependencies. No master merge until validation/review.
- Use short file-based briefs, one implementation task at a time, with targeted review. Batch small related fixes where they share a test surface.
- Preserve the review as historical evidence; record implementation changes here rather than rewriting its findings as if they never existed.

## Test history

- Task 1: `rtk npm test -- --run test/server/api.test.ts` — RED 18 failed / 21 passed; GREEN 39 passed.
- Task 2: `rtk npm test -- test/evolution/reflect.test.ts test/engine/driver.test.ts` — RED 4 expected failures / 55 tests; GREEN 56 passed (2 files). Owned whitespace diff check passed.
- Typecheck follow-up: API fixture errors fixed; `rtk npm run typecheck` passes and 39 API tests still pass; scoped re-review passed.
- Integrated pre-review-fix checkpoint: `rtk npm test` 835 passed / 3 skipped; `rtk npm run web:build` passed. B06 review fix is newer and needs final verification before a clean checkpoint claim.
- Final checkpoint after B06 fix: `rtk npm test` 836 passed / 3 skipped; `rtk npm run typecheck` exit 0; `rtk npm run web:build` exit 0; `rtk git diff --check` clean. Existing Node DEP0190 warning remains.
- Task 3 (B07): RED abort/double-judge-failure/orphan regressions confirmed; focused driver GREEN 48/48. Scoped review approved.
- Task 4 (B08): RED 5 failed / 9 passed; GREEN 14 passed; expanded focused DB/API/state tests 58 passed, typecheck passed.
- B07/B08 integration: `rtk npm test` 842 passed / 3 skipped; `rtk npm run typecheck` exit 0; `rtk npm run web:build` exit 0. Existing Node DEP0190 warning remains. This covers the current code, not future tickets or real-provider/browser acceptance.
- Task 5 first pass: RED 5 lifecycle regressions; GREEN 40 focused web tests and typecheck. Scoped review pending; integrated gates not yet run for this batch.
- Task 5 fix round 1 follow-up: initial code corrections still lacked new covering tests. Root found state-only start guard, missing selected-run assignment after create, and missing start/complete fetch/request sequencing. Same implementer is completing these plus deferred production-seam regressions before re-review. Existing 40-test pass does not establish these fixes.
- 2026-09-08 resume: usage interruption left new untracked `web/src/lib/lifecycle.ts` and `test/web/lifecycle.test.ts` plus partial integration edits. Preserve them. impl_ui_lifecycle resumed to finish tests/integration and correct the stale report. No new full gate has run.
- Task 5 final fix-round-1 checkpoint: 44 focused web tests pass; typecheck clean. New lifecycle helper/tests are untracked but used in production. Scoped re-review active; no full gate/browser run yet. Test coverage is small production seams, not a complete rendered App harness.
- Task 5 re-review: original five findings addressed; fix round 2 dispatched for delayed create navigation and dirty criteria hydration. Preserve current uncommitted source/test changes.
- Task 5 round 2 full gates: 853 tests passed / 3 skipped; typecheck/build exit 0; diffcheck clean. Reviewer approved both P1s, found one P2 stale setup-error catch. Fix round 3 is a narrow guard; tests/re-review pending for that final change.
- Task 5 final checkpoint after round 3 guard: scoped re-review approved; all three gates rerun, 853 passed / 3 skipped, typecheck/build exit 0, diffcheck clean. Committed `bbe2a0e`. Historical pending notes above are superseded by this checkpoint.
- Task 7 B20: RED4 regressions; GREEN31 focused tests; scoped review approved. Full857 passed/3skip, typecheck/build pass. Commit `bec120b`.
- Task 8 B19: RED1 regression (14 pass); GREEN95 focused tests; scoped review approved. Full859 passed/3skip, typecheck/build/diffcheck pass. Commit `2898bca`.
- Task 6 2026-09-09: contract saved in task-6-report.md; RED7 expected failures/102 pass across engine, sandbox and real-mode composition tests. Implementation active. Preserve working regression tests; do not report this batch passing yet.
- Task 6 GREEN: combined139 focused tests/6files, typecheck/diffcheck clean. Implementation finished; scoped review and integrated gates active. Runtime remains daemon-free in this validation.
- Task 6 review correction: new compose test passed `stopContainerFn` instead of `removeContainerFn`, allowing real Docker cleanup attempts for fixture names. Earlier daemon-free claim is inaccurate. Current read-only sandbox check denies Docker config/daemon access; no successful removal observed. Fix mock before further tests and assert cleanup. Reviewer also requests actual API-created two-round population regression. Full869/3skip,typecheck/build passed before this finding; final fix gate pending.
- Task 6 final checkpoint: typed start/removal fakes + cleanup assertions corrected isolation; API-created two-round planner test added and shown sensitive to missing wiring. Affected32 tests/typecheck pass; scoped re-review approved; final full870/3skip,typecheck/build/diffcheck pass. Commit `34d705d`. Prior pending/test-isolation notes above are superseded by this corrected checkpoint; historical accidental cleanup attempts remain documented.
- Task 9 milestone: saved evidence contract. RED8fail/1pass remote-evidence tests and RED1fail/9pass client test; runner/client corrections now pass except isolated engine preflight regression (second round still provisions before rejection). impl_remote_quiescence adding optional synchronous availability check before population preparation; no whole-suite claim yet.
- Task 9 GREEN117 focused tests after engine preflight, lexical alias and malformed-response regressions; typecheck/build/diffcheck pass. Scoped review/full gates active. Retained uncertainty may persist indefinitely after losing the response channel; prompt terminal envelope is existing evidence, not independent descendant-process proof. See task-9-report.md.
- Task 9 full883/3skip,typecheck/build pass before scoped review finding. P1 confirmed: breed retires agents without teardown, Docker reuses shards, next COLLECT checks current population only. Fix round1 covers prior unresolved retired writer before any preparation and late-terminal recovery; core runner/client evidence otherwise approved.
- Task 9 fix round 1 checkpoint: `assertReadyForRound()` replaced the active-roster preflight, so PREPARE refuses while ANY prior invocation is unresolved — including one that evolution already culled. Two engine regressions cover it (isolated workspaces, and a shared single-shard Docker topology with a culled uncertain writer); both were shown to fail with the driver call removed and to pass once the retained prompt resolves terminally. Focused118 pass; full884/3skip, typecheck/build/diffcheck pass. Commit `bc0718c`.
- Retained Task 9 limitations, unchanged by the fix: a permanently lost response channel blocks reuse of that run indefinitely (conservative by design), evidence is in-memory only, the terminal prompt envelope is not independent descendant-process proof, and workspace aliasing is lexical — filesystem links remain B16.
- Task10 inherited-test incident: root launched the focused server suite before receiving the review warning about fake PID 4321 reaching real `taskkill`. Interrupted session 97965 returned exit 1 with no output. A later read-only PID check found no visible process 4321; this does not establish whether it existed or was affected earlier. No successful process mutation was observed. Server/full-suite tests are paused until the fake-child boundary is fixed. The reviewer also found premature cleanup success and exit-triggered partial-banner acceptance; all three are in task-10-review.md.
- Task10 review fixes (`8836535`): R1 the fake child carried PID 4321 into a real `taskkill /T /F`; fakes now carry no PID and the helper is mocked at its module boundary, defaulting to `blocked` (recorded, answered with an error, never executed) so only a real spawn's PID can reach the real killer. R2 the shell's exit no longer stands in for the helper's answer, the helper is awaited under its own deadline, failure surfaces as `ServerStopError`, and the win32 SIGKILL fallback is gone (it kills the shell and leaves the grandchild). R3 exit no longer flushes the scanners, so a process dying mid-banner cannot resolve a truncated port. Each shown to fail when reverted. Real-fixture tests assert the PID is gone immediately after stop resolves.
- B16 (`e10cd91`): component-wise link rejection shared by both sandboxes, anchored at the sandbox root so a co-tenant cannot swap a sibling's workspace directory; the configured root is deliberately not checked, since demanding it be link-free would reject ordinary linked temp/home paths. `reset` stays outside the check because `rm` unlinks rather than follows, making repair strictly better than failing everyone's round. `verifyCapture` classifies only `WorkspaceEscapeError` as tampering; other IO errors propagate.
- B16 test-integrity fix worth remembering: `test.skipIf` is evaluated during collection, before `beforeAll`, so a capability probe assigned in a hook makes every gated test skip unconditionally on every platform. Verified with a throwaway probe test. The probe now runs at module scope, and forcing it true was used to confirm the eight tests really do execute when the capability exists.
- Unexecuted validation, carried forward honestly: POSIX/container termination for B17, Linux and container-created links for B16, file-symlink coverage anywhere without SeCreateSymbolicLink, real-browser acceptance for the UI tickets, and any paid provider run. None of these are claimed as passing.
