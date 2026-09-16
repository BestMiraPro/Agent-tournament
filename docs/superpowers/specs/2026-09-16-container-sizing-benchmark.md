# Container sizing — measured

**Date:** 2026-09-16 · **Serves:** Task 8 of
`docs/superpowers/plans/2026-09-15-container-toolchain-and-grading-audit.md`

**Machine:** Docker Desktop 29.7.2 on Windows 11, linux/amd64 engine, 16 CPUs, 6,850 MiB for Docker.
**Image:** `agent-arena:tc-50cbcb97173df525`. **Script:** `scripts/benchmark-toolchain.ts`.

## What one trial does

One container shaped like a protected worker (uid 1000, read-only root, 256m tmpfs `HOME` and `/tmp`,
no network, pinned model catalogue) with the given memory and CPU limits. It starts `opencode serve`,
waits for health, then runs a pytest that builds a 2-million-row dataframe, computes a per-asset rolling
signal and P&L, aggregates it in DuckDB and saves a matplotlib chart. The container reads its own cgroup
`memory.peak`, `memory.events` (OOM kills) and `cpu.stat` (throttling). No model call, no download.

Memory limits equal swap limits, so no trial could swap. tmpfs use counts toward the limit.

## Results

One container at a time, repeated:

| Memory | CPUs | Trials | OpenCode ready | Workload | Idle (OpenCode) | Peak | OOM kills | pytest |
| --- | ---: | ---: | --- | --- | --- | --- | --- | --- |
| 512m | 0.5 | 2 | 8.7–10.2 s | 3.9–5.9 s | 250–280 MiB | 512 MiB (limit) | 1 in each | 1 of 2 passed |
| 512m | 1 | 2 | 4.7 s | 1.6–1.9 s | 240–288 MiB | 512 MiB (limit) | 1 in each | 0 of 2 passed |
| 768m | 0.5 | 4 | 8.6–9.5 s | 4.2–9.6 s | 239–287 MiB | 545–592 MiB | 0 | 4 of 4 |
| 768m | 1 | 4 | 4.8–5.5 s | 1.9–2.4 s | 241–286 MiB | 549–592 MiB | 0 | 4 of 4 |
| 1g | 0.5 | 2 | 8.2–8.4 s | 4.7–5.6 s | 241–284 MiB | 548–591 MiB | 0 | 2 of 2 |
| 1g | 1 | 3 | 4.8–5.5 s | 2.0–2.2 s | 241–288 MiB | 549–591 MiB | 0 | 3 of 3 |

Two earlier 768m trials are excluded: one exited 1 without a result line, and one reported OpenCode
ready after 2,158 s, consistent with the machine sleeping mid-trial. Six fresh 768m trials were all clean.

Seven containers at once, 0.5 CPU each:

| Memory | Containers | OpenCode ready | Workload | Peak | OOM kills | pytest |
| --- | ---: | --- | --- | --- | --- | --- |
| 768m | 7 | 11.2–12.1 s | 6.8–8.0 s | 539–558 MiB | 0 | 7 of 7 |
| 1g | 7 | 11.7–13.6 s | 6.2–6.4 s | 543–557 MiB | 0 | 7 of 7 |

Half a CPU was throttled for 14–22 s per trial and made the workload two to three times slower than one CPU.

## Conclusions

- **512m is not enough.** OpenCode alone uses about 250 MiB before any work, and the workload was killed.
- **768m completed the workload every time**, singly and seven at once, with about 175 MiB (23%) above the
  highest peak.
- **1g stays the default.** The workload is a bounded research task; a long agent conversation grows
  OpenCode's own memory, and that was not measured. 768m is offered as a measured option in the setup form.
- Seven protected agents at 768m commit 7 × (768 MiB + 64 MiB gateway) = 5.7 GiB of ceilings, which does not
  fit this machine's 80% admission budget unless Docker is given more memory; at 512m it would, but 512m fails.

## Not measured

- Memory during a long multi-turn agent session, and several agents' sessions concurrently.
- Writable disk growth in `/work` (it is a host bind mount, bounded per file by `ulimit fsize`).
- Native Linux Docker, and any machine but this one.
