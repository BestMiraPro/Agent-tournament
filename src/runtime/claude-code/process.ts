import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { docker, type DockerFn } from '../docker/cli.js'
import type { AgentHandle } from '../sandbox.js'
import { strippedEnv, TOKEN_FD } from './env.js'

/** What one running CLI attempt looks like to the runner, wherever it runs. */
export interface ClaudeProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  /** Settles when the launched process exits, or fails to start (`error`). */
  readonly exited: Promise<{ code: number | null; signal: string | null; error?: NodeJS.ErrnoException }>
  /** Kills the CLI and everything it started. Resolves once the kill was carried out or refused. */
  kill(): Promise<void>
  /** Whether anything this attempt started is still running, by the runtime's own account. */
  probe(): Promise<'running' | 'stopped' | 'unknown'>
}

export interface LaunchRequest {
  args: string[]
  /** Variables safe on a command line. */
  settings: Record<string, string>
  /** Variables that hold a credential: only ever in a process environment. */
  secrets: Record<string, string>
  /** A token for descriptor 3 (host processes); never in argv or the environment. */
  token?: string
  /** The agent's workspace as the CLI sees it. */
  cwd: string
  /** A filename-safe key for this attempt. */
  key: string
}

export interface ClaudeLauncher {
  launch(handle: AgentHandle, request: LaunchRequest): ClaudeProcess
}

/** The CLI could not be found where this launcher looks for it. */
export class ClaudeCliMissingError extends Error {
  constructor(detail: string) {
    super(`The Claude Code CLI is not available: ${detail}. Install it (https://claude.com/claude-code) or set CLAUDE_CLI_PATH.`)
    this.name = 'ClaudeCliMissingError'
  }
}

const SAFE_KEY = /^[A-Za-z0-9._-]{1,128}$/

function exitedOf(child: ChildProcess): ClaudeProcess['exited'] {
  return new Promise((resolve) => {
    let done = false
    child.once('error', (error) => {
      if (done) return
      done = true
      resolve({ code: null, signal: null, error: error as NodeJS.ErrnoException })
    })
    child.once('exit', (code, signal) => {
      if (done) return
      done = true
      resolve({ code, signal })
    })
  })
}

/**
 * The CLI as a process of this host, in the agent's workspace.
 *
 * On POSIX it leads its own process group, so a kill takes every tool process it started with it;
 * on Windows the tree is ended with `taskkill /T /F`. A token goes to descriptor 3
 * (`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`), so it is in neither argv nor the environment that
 * tool subprocesses could read.
 */
export function localLauncher(opts: {
  cliPath: () => string | null
  baseEnv?: NodeJS.ProcessEnv
  spawnFn?: typeof spawn
  platform?: NodeJS.Platform
}): ClaudeLauncher {
  const platform = opts.platform ?? process.platform
  const spawnFn = opts.spawnFn ?? spawn
  return {
    launch(_handle, req) {
      const cli = opts.cliPath()
      if (!cli) throw new ClaudeCliMissingError('no `claude` executable on PATH')
      const env = { ...strippedEnv(opts.baseEnv ?? process.env), ...req.settings, ...req.secrets }
      const child = spawnFn(cli, req.args, {
        cwd: req.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe', ...(req.token !== undefined ? ['pipe' as const] : [])],
        detached: platform !== 'win32',
        windowsHide: true,
      })
      if (req.token !== undefined) {
        const fd = child.stdio[TOKEN_FD] as Writable | null | undefined
        fd?.on('error', () => {})
        fd?.end(req.token)
      }
      child.stdin?.on('error', () => {})
      const exited = exitedOf(child)
      let finished = false
      void exited.then(() => { finished = true })
      return {
        stdin: child.stdin!,
        stdout: child.stdout!,
        stderr: child.stderr!,
        exited,
        async kill() {
          const pid = child.pid
          if (pid === undefined) return
          if (platform === 'win32') {
            if (finished) return
            await new Promise<void>((resolve) => {
              execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15_000, windowsHide: true }, () => resolve())
            })
            return
          }
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            /* ESRCH: nothing in the group is left */
          }
        },
        async probe() {
          const pid = child.pid
          if (pid === undefined) return finished ? 'stopped' : 'unknown'
          if (platform === 'win32') return finished ? 'stopped' : 'running'
          try {
            process.kill(-pid, 0)
            return 'running'
          } catch (e) {
            return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'stopped' : 'unknown'
          }
        },
      }
    },
  }
}

/** Where a containerised CLI records the process group it leads. */
export function pidFileFor(key: string): string {
  if (!SAFE_KEY.test(key)) throw new Error(`unsafe attempt key ${JSON.stringify(key)}`)
  return `/tmp/arena-claude-${key}.pid`
}

/**
 * Records the process group the CLI leads, then becomes the CLI. A `docker exec` process already
 * leads its own session (pid = pgid = sid, seen in the agent image), so normally this is one process
 * from start to end and nothing else in the container holds the CLI's environment. Only if it is
 * not a group leader does it take `setsid -w`, whose waiting parent keeps the exec's exit meaning
 * the CLI's exit.
 */
export const LEADER_SCRIPT = [
  'if [ "$(cut -d" " -f5 /proc/$$/stat)" = "$$" ]; then echo $$ > "$0" && exec claude "$@"; fi',
  'exec setsid -w sh -c \'echo $$ > "$0" && exec claude "$@"\' "$0" "$@"',
].join('\n')

/**
 * `docker exec` arguments that start the CLI in the agent's workspace with stdin open for streamed
 * messages. Settings travel as `-e NAME=value`; secrets only through `envFile`, a 0600 file the
 * launcher removes once the CLI is running, so they never appear on a command line or in the docker
 * client's own environment, and reach only the exec'd process, never the container's.
 */
export function dockerExecArgs(container: string, req: LaunchRequest, envFile: string | null): string[] {
  const pidFile = pidFileFor(req.key)
  return [
    'exec', '-i', '-w', req.cwd,
    ...Object.entries(req.settings).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...(envFile ? ['--env-file', envFile] : []),
    container,
    'sh', '-c', LEADER_SCRIPT, pidFile,
    ...req.args,
  ]
}

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/
const SECRET_VALUE = /^[\x21-\x7e]+$/

/**
 * Writes secrets for `docker exec --env-file`: a 0600 file in a private 0700 folder. Returns the
 * file and a function that removes both.
 */
export function writeSecretEnvFile(secrets: Record<string, string>, dir: string = tmpdir()): { file: string; remove: () => void } {
  for (const [k, v] of Object.entries(secrets)) {
    if (!SECRET_NAME.test(k) || !SECRET_VALUE.test(v)) throw new Error(`secret ${k} cannot be passed in an env file`)
  }
  const folder = mkdtempSync(join(dir, 'arena-claude-env-'))
  chmodSync(folder, 0o700)
  const file = join(folder, 'env')
  writeFileSync(file, Object.entries(secrets).map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600, flag: 'wx' })
  let removed = false
  return {
    file,
    remove: () => {
      if (removed) return
      removed = true
      rmSync(folder, { recursive: true, force: true })
    },
  }
}

/** Kills the recorded process group (dash's `kill` takes `-<pgid>`, not `-- -<pgid>`). */
export const KILL_GROUP_SCRIPT = 'p=$(cat "$0" 2>/dev/null) && [ -n "$p" ] && kill -KILL "-$p" 2>/dev/null; exit 0'

/**
 * Exit 0 while a live (non-zombie) process remains in the recorded group, 1 when none does, 3 when
 * nothing was recorded. Zombies are skipped: a shard's PID 1 does not reap orphans, and `kill -0`
 * succeeds on a zombie (seen in the agent image), which would leave every kill unconfirmed.
 */
export const PROBE_GROUP_SCRIPT = [
  'p=$(cat "$0" 2>/dev/null) || exit 3',
  'for s in /proc/[0-9]*/stat; do',
  '  read -r line < "$s" 2>/dev/null || continue',
  '  rest=${line##*) }',
  '  set -- $rest',
  '  [ "$3" = "$p" ] && [ "$1" != "Z" ] && exit 0',
  'done',
  'exit 1',
].join('\n')

/**
 * The CLI inside the agent's Docker shard. Killing the local `docker exec` client would leave the
 * CLI running in the container, so stopping goes through the container: the recorded process group
 * is killed (`KILL_GROUP_SCRIPT`), and `PROBE_GROUP_SCRIPT` answers whether any of it is left.
 */
export function dockerExecLauncher(opts: {
  containerFor: (handle: AgentHandle) => string | null
  baseEnv?: NodeJS.ProcessEnv
  spawnFn?: typeof spawn
  run?: DockerFn
  /** Where secret env files are written; the OS temp folder by default. */
  envFileDir?: string
}): ClaudeLauncher {
  const spawnFn = opts.spawnFn ?? spawn
  const run = opts.run ?? docker
  return {
    launch(handle, req) {
      const container = opts.containerFor(handle)
      if (!container) throw new Error(`no container is placed for agent ${handle.agentId}`)
      const pidFile = pidFileFor(req.key)
      const secrets = Object.keys(req.secrets).length > 0 ? writeSecretEnvFile(req.secrets, opts.envFileDir) : null
      let child: ChildProcess
      try {
        child = spawnFn('docker', dockerExecArgs(container, req, secrets?.file ?? null), {
          env: strippedEnv(opts.baseEnv ?? process.env),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (e) {
        secrets?.remove()
        throw e
      }
      child.stdin?.on('error', () => {})
      const exited = exitedOf(child)
      // Docker reads the env file before the exec starts, so the CLI's first output proves it is no
      // longer needed; an exec that never produces any removes it when it ends.
      if (secrets) {
        child.stdout?.once('data', () => secrets.remove())
        void exited.then(() => secrets.remove())
      }
      const inContainer = async (script: string, timeoutMs: number) => {
        try {
          return await run(['exec', container, 'sh', '-c', script, pidFile], timeoutMs)
        } catch (e) {
          return { code: -1, stdout: '', stderr: (e as Error).message }
        }
      }
      return {
        stdin: child.stdin!,
        stdout: child.stdout!,
        stderr: child.stderr!,
        exited,
        async kill() {
          await inContainer(KILL_GROUP_SCRIPT, 20_000)
        },
        async probe() {
          const r = await inContainer(PROBE_GROUP_SCRIPT, 20_000)
          if (r.code === 0) return 'running'
          if (r.code === 1 || r.code === 3) return 'stopped'
          // A container that is gone or stopped holds no process at all.
          return /no such container|is not running/i.test(`${r.stderr}\n${r.stdout}`) ? 'stopped' : 'unknown'
        },
      }
    },
  }
}
