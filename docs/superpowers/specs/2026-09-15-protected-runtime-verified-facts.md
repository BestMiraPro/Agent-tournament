# Protected worker runtime — verified facts

**Date:** 2026-09-15 · **Branch:** `phase5-review-fixes` · **Serves:** Task 3 of
`docs/superpowers/plans/2026-09-15-container-toolchain-and-grading-audit.md`

Every fact below was observed on this machine (Docker Desktop, Windows 11, linux/amd64 engine, 16 CPUs,
6.69 GiB) with OpenCode 1.18.21. No credentials file was mounted into any container and no real model
provider was contacted: model calls went to a fake OpenAI-compatible upstream written for the probe. Every
container and network the probes created was labelled and removed afterwards (verified empty).

## Docker networking

| Observation | Consequence |
| --- | --- |
| A container on a `--internal` network cannot resolve or reach `host.docker.internal`, public names, or `1.1.1.1:443` (`EAI_AGAIN`, `ENETUNREACH`). | Workers on an internal network have no egress. |
| It cannot resolve or reach a container on a different internal network (`ENETUNREACH`). | One internal network per shard isolates shards from each other. |
| A container on the default bridge reaches a host process listening on `127.0.0.1` via `host.docker.internal`. | The relay can stay a loopback-only process on the host; keys never enter a container. |
| A container joined to both a shard network and the bridge forwards TCP between them. | One small gateway per shard carries worker → relay traffic. |
| **A container on an internal network cannot publish a port** (`docker port`: no public port). | The app cannot reach a protected worker's API directly; the shard gateway must also forward host → worker. |
| Connecting to the internal network's gateway IP on the relay port was refused (`ECONNREFUSED`), i.e. the address answers. | A service bound on the Docker VM's bridge interface could be reachable from workers. Nothing of ours listens there; recheck if that changes. |

## OpenCode inside a protected worker

| Observation | Consequence |
| --- | --- |
| With `OPENCODE_CONFIG` pointing at a file that sets `provider.<id>.options.baseURL` and `apiKey`, and no `auth.json`, the provider is listed and a prompt reaches that base URL with `Authorization: Bearer <apiKey>`. | The run token goes where the key would; workers hold no credential. |
| The OpenAI-compatible provider SDK is bundled: nothing is installed under `~/.cache/opencode` at first use. | Model calls work without egress. |
| **The grep tool failed offline with "ripgrep execution failed"**: no `rg` on PATH, and OpenCode's `~/.cache/opencode/bin` stayed empty. | `ripgrep` is installed in the image and listed as a required tool. |
| With ripgrep 13.0.0 at `/usr/bin/rg` in the image, the same grep tool call ran offline and returned its result ("No files found" for a pattern absent from `/work`); OpenCode's cache `bin` stayed empty. | The fix works: nothing is downloaded at first use. |
| With no credentials file, OpenCode lists seven OpenCode Zen models (among them `muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free` and `big-pickle`) and sends `Authorization: Bearer public` to the Zen base URL. | Behind the relay, Zen without a stored key uses the same `public` key, so free Zen models keep working in protected mode. |
| Running as uid 1000 with `--read-only`, a tmpfs `HOME` and `/tmp`, OpenCode writes `~/.local/share/opencode`, `~/.local/state/opencode`, `~/.cache/opencode`, `~/.config/opencode` and `/tmp`, and `/work` (a Docker Desktop bind mount) is writable. | A read-only root filesystem works with tmpfs for those paths. |
| **Bind-mounting the catalogue at `$HOME/.cache/opencode/models.json` under a tmpfs `HOME` makes Docker create `.cache/opencode` as root**, and OpenCode then fails with `EACCES` creating `.cache/opencode/bin`. | The catalogue is mounted read-only elsewhere and copied into the tmpfs `HOME` at startup. |
| In the toolchain image, a `bash` tool call imported numpy, pandas, scipy, duckdb, pyarrow and matplotlib and wrote to `/work` as uid 1000, offline. | The research toolchain works with no downloads. |

## The relay chain

Worker (toolchain image, uid 1000, read-only root, internal network only) → shard gateway → the app's
`RelayPolicy` and relay server on host loopback → upstream: three model calls were relayed with status 200.
The upstream received only the upstream key; the worker's run token never reached it.

## Real providers through the relay (September 15–16, 2026)

Three small protected runs with real models, after the user confirmed the roster's models are free to use.

| Observation | Consequence |
| --- | --- |
| W&B (`zai-org/GLM-5.3-Flash`) streamed tool-using agent turns through the relay; the agent wrote, ran and reported a Python script. | The OpenAI-compatible path works against a real upstream. |
| Google (`gemini-3.8-flash`) requests reached Google through the relay and came back HTTP 429 "quota exceeded" for the configured key. | The `x-goog-api-key` swap and the Google route work; that key's quota was spent. A full Google turn is still unobserved. |
| OpenCode Zen refused relayed free-tier calls with HTTP 400 "OpenCode's free tier can only be used in OpenCode" while only `content-type` and `accept` were forwarded. After forwarding OpenCode's bounded client headers (`user-agent`, `x-opencode-client`, `-project`, `-session`, `-request`) to Zen only, `muse-spark-1.3-contributor-free` completed the task twice. | Zen's free tier recognises OpenCode by those headers; none carries a credential. |
| With no `external_directory` allowance for container paths, OpenCode asked to read `/context` and `/run/arena` and the unattended reply rejected it; one agent then read the files with `python3`. | Competitor profiles allow reading those two mounts. Tool rules are not a boundary; the read-only mounts are. |
| A context folder given as a Windows 8.3 short path left the grader's allow rule unmatched, because OpenCode checks the real long path. After resolving the real path, the grader built its criteria from the brief and checked a factual claim against python.org. | Folders are canonicalised once at composition. |
| GLM-5.3-Flash stalled mid-reply twice: once for a worker through the relay, once for a host-side reflect call that does not use the relay. | The stall is upstream; the agent timeout bounds it. |
| When the app was quit mid-round, the next docker run's sweep removed the stranded run's four containers, two networks and runtime folder. | Crash recovery works on real resources. |
| `test/e2e/container-policy.test.ts` (gated, 22 s) confirmed from inside workers: uid 1000; toolchain, system and tool manifest unwritable; no readable credential; no DNS, direct IP, host service or sibling shard; no script download or `pip install`; relay allow plus 401/403/404/405/429 refusals; offline numpy/pandas/DuckDB/pytest; clean removal. | The protected boundaries hold on Docker Desktop for Windows. |

## Not verified yet

- A complete Google or Anthropic model turn through the relay (the Google key was out of quota; no Anthropic model is in the roster).
- Structured output (`json_schema`) from a worker through the relay; grading runs on the host and does not use the relay.
- A native Linux Docker engine: every observation here is from Docker Desktop on Windows.
