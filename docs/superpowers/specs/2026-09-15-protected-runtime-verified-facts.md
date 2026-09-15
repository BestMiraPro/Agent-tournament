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

## Not verified yet

- Streaming and structured output through the relay against the real W&B, OpenCode Zen and Google
  endpoints. That needs real model calls and waits for explicit approval.
- Google and Anthropic request shapes through the relay (the policy handles them; only the OpenAI-compatible
  path was exercised end to end).
- Whether the real OpenCode Zen endpoint accepts `public` for its free models when it arrives through the
  relay. The header is exactly what OpenCode sends on its own; the endpoint's answer needs a real call.
