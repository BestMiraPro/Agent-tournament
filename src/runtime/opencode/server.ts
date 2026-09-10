import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { OpenCodeClient } from './client.js'

/** The server prints `opencode server listening on http://127.0.0.1:<port>` on startup. */
export function parseServerPort(line: string): number | null {
  // The host alternation must handle a bracketed IPv6 literal (`http://[::1]:4599`)
  // before the plain-host case: `[^:]+` cannot match a host containing colons, so an
  // IPv6 bind would yield null and startServer would hang until its startup timeout.
  const m = /listening on https?:\/\/(?:\[[^\]]+\]|[^:/]+):(\d+)/.exec(line)
  if (m === null) return null
  const port = Number(m[1])
  return port >= 1 && port <= 65535 ? port : null
}

/**
 * The most an unterminated line may retain before the head is dropped.
 *
 * A stream that never emits a newline must not grow the buffer without limit. Keeping
 * the tail rather than discarding everything means a banner still arriving at the end
 * of a flood survives; only output far older than any banner is lost.
 */
const MAX_PENDING_CHARS = 64 * 1024

/** How long termination is awaited before escalating, and again before giving up. */
const STOP_GRACE_MS = 5_000

/**
 * Turns stream chunks into whole lines.
 *
 * A chunk boundary is not a line boundary: the banner can arrive split anywhere,
 * including inside the port digits, where parsing the first half would resolve a
 * truncated port and connect to the wrong place (or nothing at all). So nothing is
 * parsed until a line is complete — plus `flush`, for a process whose last line
 * never got its terminator.
 */
export function createLineScanner(onLine: (line: string) => void) {
  let pending = ''
  const emit = (line: string): void => onLine(line.endsWith('\r') ? line.slice(0, -1) : line)

  return {
    push(chunk: string): void {
      pending += chunk
      let nl = pending.indexOf('\n')
      while (nl !== -1) {
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        emit(line)
        nl = pending.indexOf('\n')
      }
      if (pending.length > MAX_PENDING_CHARS) pending = pending.slice(-MAX_PENDING_CHARS)
    },
    /** Stream end: emit whatever is left, once. */
    flush(): void {
      if (pending.length === 0) return
      const line = pending
      pending = ''
      emit(line)
    },
  }
}

export interface ServerHandle {
  baseUrl: string
  client: OpenCodeClient
  stop(): Promise<void>
}

export interface StartServerOptions {
  /** Port to bind. 0 lets the OS choose and the port is read from the banner. */
  port?: number
  timeoutMs?: number
  startupTimeoutMs?: number
  /**
   * Launch command. Internal and trusted: production passes nothing and gets the
   * `opencode` constant. On win32 it is shell-interpreted (see the spawn call), so it
   * must never carry anything a user or an agent supplied.
   */
  command?: string
  /** Test seam for a fixture that is not the real server; defaults to the serve args. */
  args?: string[]
  /** Test seam for driving stdio without a real process. */
  spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
}

/** Attach to an already-running server instead of spawning one. */
export async function attachServer(
  baseUrl: string,
  timeoutMs = 600_000,
): Promise<ServerHandle> {
  const client = new OpenCodeClient({ baseUrl, timeoutMs })
  if (!(await client.health())) {
    throw new Error(`attachServer: no healthy OpenCode server at ${baseUrl}`)
  }
  // We did not start it, so stopping it is not ours to do.
  return { baseUrl, client, stop: async () => {} }
}

/**
 * Terminates the process we spawned and everything it started.
 *
 * On win32 the launch goes through a shell so `opencode` can resolve its `.cmd` shim,
 * and `child.kill()` then kills only that shell: the server keeps running, holding its
 * port, with nothing left pointing at it. `taskkill /T` walks down from our own child's
 * PID, so it reaches the grandchild and touches nothing else — the PID is a number we
 * spawned ourselves, never a process name, and `execFile` runs no shell.
 *
 * Bounded on purpose: if the tree does not go away, escalate once, then return rather
 * than let shutdown hang. If our child has already exited, its descendants have been
 * reparented and are no longer reachable by this PID — that residue is out of scope here.
 */
function stopChild(child: ChildProcess): Promise<void> {
  const dead = (): boolean => child.exitCode !== null || child.signalCode !== null
  if (dead() || child.pid === undefined) return Promise.resolve()

  const exited = new Promise<void>((resolve) => {
    if (dead()) resolve()
    else child.once('exit', () => resolve())
  })

  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
      /* the wait below, not this exit code, decides whether the tree is gone */
    })
  } else {
    child.kill()
  }

  const bounded = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), STOP_GRACE_MS) }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  return (async () => {
    if (await bounded()) return
    try {
      child.kill('SIGKILL')
    } catch {
      /* nothing left to signal */
    }
    await bounded()
  })()
}

export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  const port = opts.port ?? 0
  const command = opts.command ?? 'opencode'
  const args = opts.args ?? ['serve', '--hostname', '127.0.0.1', '--port', String(port)]
  const startupTimeoutMs = opts.startupTimeoutMs ?? 30_000
  const spawnFn = opts.spawnFn ?? spawn

  const env = { ...process.env }
  // Our client never sends Basic auth, so an inherited server-auth env can only
  // 401 our own loopback plumbing: a shell leaking both vars makes every spawned
  // server demand credentials our client does not have. Scrub them from the copy.
  delete env.OPENCODE_SERVER_USERNAME
  delete env.OPENCODE_SERVER_PASSWORD

  // The win32 shell is what lets `opencode` resolve its `.cmd` shim, and it is what
  // raises DEP0190 (args are concatenated, not escaped). That warning stays: silencing
  // it would mean building the command line ourselves, which is the thing worth avoiding.
  // Both `command` and `args` are internal constants; nothing external reaches them.
  // windowsHide keeps the launcher from flashing a console window.
  const child = spawnFn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    windowsHide: true,
    env,
  })

  // One shutdown path for both the startup timeout and a caller's stop, and safe to
  // call again: the second caller awaits the first attempt instead of starting another.
  let stopping: Promise<void> | null = null
  const stop = (): Promise<void> => (stopping ??= stopChild(child))

  const resolvedPort = await new Promise<number>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const onLine = (line: string): void => {
      if (settled) return
      const parsed = parseServerPort(line)
      if (parsed !== null && finish()) resolve(parsed)
    }

    // Separate scanners: a half-line on stdout must never be completed by an
    // unrelated half-line on stderr.
    const out = createLineScanner(onLine)
    const err = createLineScanner(onLine)

    const onOut = (buf: Buffer): void => out.push(buf.toString())
    const onErr = (buf: Buffer): void => err.push(buf.toString())
    const onOutEnd = (): void => out.flush()
    const onErrEnd = (): void => err.flush()
    const onError = (e: Error): void => { if (finish()) reject(e) }
    const onExit = (code: number | null): void => {
      // A process that printed its banner without a trailing newline and then exited
      // still told us where it listened; flush before deciding it never started.
      out.flush()
      err.flush()
      if (finish()) reject(new Error(`startServer: process exited with code ${code} before starting`))
    }

    /** Detaches everything exactly once; false means someone already settled. */
    function finish(): boolean {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      child.stdout?.off('data', onOut)
      child.stdout?.off('end', onOutEnd)
      child.stderr?.off('data', onErr)
      child.stderr?.off('end', onErrEnd)
      child.off('error', onError)
      child.off('exit', onExit)
      // Keep draining: a pipe nobody reads eventually blocks the server's own writes.
      child.stdout?.resume()
      child.stderr?.resume()
      return true
    }

    timer = setTimeout(() => {
      if (!finish()) return
      // Reject only once the tree is actually gone, so a caller that gives up on
      // startup is not racing a server that still holds the port.
      void stop().finally(() =>
        reject(new Error('startServer: timed out waiting for the startup banner')),
      )
    }, startupTimeoutMs)

    child.stdout?.on('data', onOut)
    child.stdout?.on('end', onOutEnd)
    child.stderr?.on('data', onErr)
    child.stderr?.on('end', onErrEnd)
    child.on('error', onError)
    child.on('exit', onExit)
  })

  const baseUrl = `http://127.0.0.1:${resolvedPort}`
  const client = new OpenCodeClient({ baseUrl, timeoutMs: opts.timeoutMs ?? 600_000 })

  return { baseUrl, client, stop }
}
