import { execFile } from 'node:child_process'

/** The shape of `docker` itself, so every caller can be handed a fake in tests. */
export type DockerFn = (args: string[], timeoutMs?: number) => Promise<ExecResult>

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

/** Runs `docker` with a hard timeout. A hung CLI call must never hang a round. */
export function docker(args: string[], timeoutMs = 60_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
      })
    })
  })
}

/** `docker port` prints e.g. `4096/tcp -> 127.0.0.1:32769`. */
export function parsePortMapping(out: string): number | null {
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue

    // `docker port <name>` prints the mapping with an arrow:
    //     4096/tcp -> 127.0.0.1:32769
    // but `docker port <name> 4096/tcp` prints ONLY the host side:
    //     127.0.0.1:32769
    // Both forms must parse. Matching the arrow alone made every provision fail with
    // "could not discover a published port", because the caller passes the port.
    const afterArrow = line.includes('->') ? line.slice(line.lastIndexOf('->') + 2).trim() : line

    const m = /^(?:\[[^\]]+\]|[^:]+):(\d+)$/.exec(afterArrow)
    if (m) return Number(m[1])
  }
  return null
}

export interface RunSpec {
  name: string
  image: string
  hostDir: string
  memory: string
  cpus: number
  authFile: string | null
  /** Host models.dev catalogue to pin inside the container; see buildRunArgs. */
  modelsFile?: string | null
  pidsLimit?: number
  maxFileBytes?: number
  maxOpenFiles?: number
}

/**
 * Every limit here exists to stop agent-authored code degrading the host.
 *
 * Agents run arbitrary shell commands and are selected on outcome, so a strategy that
 * happens to spawn processes, allocate memory or write huge files is something the
 * tournament can actively evolve toward. These caps are the backstop.
 *
 * Note what is absent: `--gpus` is never passed, so containers get no GPU access at all.
 */
export function buildRunArgs(spec: RunSpec): string[] {
  const pids = spec.pidsLimit ?? 256
  const fsize = spec.maxFileBytes ?? 268_435_456 // 256MB per file
  const nofile = spec.maxOpenFiles ?? 2048

  return [
    'run', '-d',
    '--name', spec.name,

    // Memory: --memory-swap equal to --memory disables swap for the container.
    // Without this a leaking agent swaps instead of being killed, which drags the
    // whole host to a crawl rather than failing one agent.
    '-m', spec.memory,
    '--memory-swap', spec.memory,

    '--cpus', String(spec.cpus),

    // A fork bomb is a trivially reachable failure mode for an agent running shell.
    '--pids-limit', String(pids),

    // Disk: cap any single file, and cap open descriptors.
    '--ulimit', `fsize=${fsize}`,
    '--ulimit', `nofile=${Math.floor(nofile / 2)}:${nofile}`,

    // Least privilege: no capabilities, no way to gain more.
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',

    // Loopback only: never expose an unsecured opencode server on the network.
    '-p', '127.0.0.1:0:4096',
    '-v', `${spec.hostDir}:/work`,
    ...(spec.authFile
      ? ['-v', `${spec.authFile}:/root/.local/share/opencode/auth.json:ro`]
      : []),
    // A fresh container has no models.dev cache, so OpenCode answers from the catalogue
    // bundled into its binary until a background fetch lands. The September 13 shards lost
    // that race: their bundled catalogue lacked two W&B models the host listed, and every
    // agent on them failed with ProviderModelNotFoundError. Pinning the host's catalogue
    // read-only, with the fetch off, makes the shard resolve what the host validated.
    // Read-only also keeps agents from rewriting provider endpoints in it.
    ...(spec.modelsFile
      ? [
          '-v', `${spec.modelsFile}:/root/.cache/opencode/models.json:ro`,
          '-e', 'OPENCODE_DISABLE_MODELS_FETCH=1',
        ]
      : []),
    spec.image,
  ]
}

export async function dockerAvailable(): Promise<boolean> {
  const r = await docker(['info', '--format', '{{.ServerVersion}}'], 20_000)
  return r.code === 0 && r.stdout.trim().length > 0
}

export async function containerState(name: string): Promise<'running' | 'stopped' | 'absent'> {
  const r = await docker(['inspect', '-f', '{{.State.Running}}', name], 20_000)
  if (r.code !== 0) return 'absent'
  return r.stdout.trim() === 'true' ? 'running' : 'stopped'
}

export async function hostPortFor(name: string): Promise<number | null> {
  const r = await docker(['port', name, '4096/tcp'], 20_000)
  if (r.code !== 0) return null
  return parsePortMapping(r.stdout)
}

/**
 * Force-removes a container. Never throws: removal is cleanup, and cleanup must not be
 * the thing that fails a run.
 *
 * A silent failure here is exactly how a container leaks, so a removal that does not
 * succeed is reported through `onWarning` rather than swallowed. Callers that supply no
 * `onWarning` keep the old silent behaviour.
 */
export async function removeContainer(
  name: string,
  onWarning?: (message: string) => void,
  run: DockerFn = docker,
): Promise<void> {
  try {
    const r = await run(['rm', '-f', name], 30_000)
    if (r.code !== 0) {
      onWarning?.(
        `Could not remove container ${name}: ${(r.stderr || r.stdout).trim().slice(-300)}. ` +
          `It may still be running — check with \`docker ps -a --filter name=${name}\`.`,
      )
    }
  } catch (e) {
    onWarning?.(
      `Could not remove container ${name}: ${(e as Error).message}. ` +
        `It may still be running — check with \`docker ps -a --filter name=${name}\`.`,
    )
  }
}
