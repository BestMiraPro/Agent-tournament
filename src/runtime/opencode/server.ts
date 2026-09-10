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

/** Raised when termination could not be established, rather than reported as success. */
export class ServerStopError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ServerStopError'
  }
}

const TIMED_OUT = Symbol('timed out')

/** Resolves the promise's value, or TIMED_OUT. Never rejects, never leaves a timer. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Runs the tree killer and resolves its failure, or null on success. Never rejects. */
function taskkillTree(pid: number): Promise<Error | null> {
  return new Promise((resolve) => {
    // A number we spawned ourselves — never a process name, and execFile runs no shell.
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) =>
      resolve(error ?? null),
    )
  })
}

/**
 * Terminates the process we spawned and everything it started.
 *
 * On win32 the launch goes through a shell so `opencode` can resolve its `.cmd` shim, and
 * `child.kill()` then kills only that shell: the server keeps running, holding its port,
 * with nothing left pointing at it. `taskkill /T` walks down from our own child's PID, so
 * it reaches the grandchild.
 *
 * Two things this deliberately does NOT do. It does not treat the shell's exit as proof on
 * its own — the helper is awaited (with its own deadline) before the root's exit is taken
 * as confirmation. And it does not fall back to `child.kill('SIGKILL')` on win32, because
 * that kills the shell and leaves the grandchild: reporting success after it would be
 * exactly the bug this function exists to fix. When termination cannot be established it
 * raises `ServerStopError` instead. On POSIX there is no shell layer, so signalling the
 * child IS signalling the server, and SIGTERM→SIGKILL is a real escalation.
 *
 * OWNERSHIP LIMIT: if our own child has already exited, any descendant it left has been
 * reparented and is no longer reachable from this PID — and that PID may by then belong
 * to something else, so it must not be signalled. That case returns without claiming the
 * descendants are gone.
 */
function stopChild(child: ChildProcess): Promise<void> {
  const dead = (): boolean => child.exitCode !== null || child.signalCode !== null

  return (async () => {
    if (dead() || child.pid === undefined) return
    const pid = child.pid

    let detach = (): void => {}
    const exited = new Promise<void>((resolve) => {
      const onExit = (): void => resolve()
      child.once('exit', onExit)
      detach = () => { child.off('exit', onExit) }
      if (dead()) resolve()
    })
    const gone = async (ms: number): Promise<boolean> => (await within(exited, ms)) !== TIMED_OUT

    try {
      if (process.platform !== 'win32') {
        child.kill()
        if (await gone(STOP_GRACE_MS)) return
        try {
          child.kill('SIGKILL')
        } catch {
          /* nothing left to signal */
        }
        if (await gone(STOP_GRACE_MS)) return
        throw new ServerStopError(`server process ${pid} did not exit after SIGKILL`)
      }

      // On win32 the ONLY thing that evidences a stopped tree is the helper reporting
      // success. The shell's own exit says the launcher is gone and nothing about the
      // server it started, so it is never accepted in the helper's place.
      const failure = await within(taskkillTree(pid), STOP_GRACE_MS)
      if (failure === TIMED_OUT) {
        throw new ServerStopError(
          `taskkill for ${pid} did not finish within ${STOP_GRACE_MS}ms; the server tree may still be running`,
        )
      }
      if (failure !== null) {
        const launcherGone = await gone(0)
        throw new ServerStopError(
          launcherGone
            ? `taskkill for ${pid} failed after the launcher had already exited; its descendants cannot be confirmed stopped`
            : `taskkill for ${pid} failed`,
          { cause: failure },
        )
      }
      // The helper reported terminating the tree. Our own child's exit is then a
      // consistency check on what we believed we owned, not the primary evidence.
      if (await gone(STOP_GRACE_MS)) return
      throw new ServerStopError(`server process ${pid} survived taskkill /T`)
    } finally {
      detach()
    }
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

    let exited = false

    const onOut = (buf: Buffer): void => out.push(buf.toString())
    const onErr = (buf: Buffer): void => err.push(buf.toString())

    /**
     * A stream closing is a line delimiter only while the writer is still alive.
     *
     * A dying process leaves whatever bytes it had already pushed, so flushing then can
     * turn `...127.0.0.1:45` into a resolved port 45 and hand back a handle to a process
     * that is already gone — the truncated-port bug, arriving by a different route. The
     * turn's delay is what lets an `exit` that follows `end` be seen first; when the two
     * arrive further apart than that, the check below is still what decides.
     */
    const flushIfAlive = (scanner: { flush(): void }) => (): void => {
      setImmediate(() => {
        if (!exited && !settled) scanner.flush()
      })
    }
    const onOutEnd = flushIfAlive(out)
    const onErrEnd = flushIfAlive(err)

    const onError = (e: Error): void => { if (finish()) reject(e) }
    const onExit = (code: number | null): void => {
      // Deliberately no flush: process exit is not the stream-end delimiter that makes
      // an unterminated final line trustworthy.
      exited = true
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
      const message = 'startServer: timed out waiting for the startup banner'
      // Reject only once the tree is actually gone, so a caller that gives up on startup
      // is not racing a server that still holds the port. A cleanup failure is attached
      // rather than discarded — and rather than left as an unhandled rejection, which is
      // what awaiting this with `void` would produce once stop() can reject.
      stop().then(
        () => reject(new Error(message)),
        (cause: unknown) => reject(new Error(`${message} (cleanup also failed)`, { cause })),
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
