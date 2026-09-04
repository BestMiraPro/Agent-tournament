import { spawn, type ChildProcess } from 'node:child_process'
import { OpenCodeClient } from './client.js'

/** The server prints `opencode server listening on http://127.0.0.1:<port>` on startup. */
export function parseServerPort(line: string): number | null {
  // The host alternation must handle a bracketed IPv6 literal (`http://[::1]:4599`)
  // before the plain-host case: `[^:]+` cannot match a host containing colons, so an
  // IPv6 bind would yield null and startServer would hang until its startup timeout.
  const m = /listening on https?:\/\/(?:\[[^\]]+\]|[^:/]+):(\d+)/.exec(line)
  return m ? Number(m[1]) : null
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
  command?: string
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
  return { baseUrl, client, stop: async () => {} }
}

export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  const port = opts.port ?? 0
  const command = opts.command ?? 'opencode'
  const startupTimeoutMs = opts.startupTimeoutMs ?? 30_000

  const child: ChildProcess = spawn(
    command,
    ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
    { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
  )

  const resolvedPort = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        // Timeout is the only path that leaks: error/exit mean the child is already dead/dying.
        child.kill()
        reject(new Error('startServer: timed out waiting for the startup banner'))
      },
      startupTimeoutMs,
    )
    const onData = (buf: Buffer) => {
      const p = parseServerPort(buf.toString())
      if (p !== null) {
        clearTimeout(timer)
        resolve(p)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`startServer: process exited with code ${code} before starting`))
    })
  })

  const baseUrl = `http://127.0.0.1:${resolvedPort}`
  const client = new OpenCodeClient({ baseUrl, timeoutMs: opts.timeoutMs ?? 600_000 })

  return {
    baseUrl,
    client,
    stop: async () => {
      child.kill()
    },
  }
}
