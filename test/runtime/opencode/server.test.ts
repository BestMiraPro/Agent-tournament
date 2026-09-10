import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { attachServer, createLineScanner, parseServerPort, startServer } from '../../../src/runtime/opencode/server.js'

const spawned = vi.hoisted(() => ({ children: [] as ChildProcess[], options: [] as unknown[] }))

// Capture the real child so the tests can assert kill delivery on the handle
// (passthrough — the child still really spawns).
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return {
    ...orig,
    spawn: (...args: Parameters<typeof orig.spawn>) => {
      const child = orig.spawn(...args)
      spawned.children.push(child)
      spawned.options.push(args[2])
      return child
    },
  }
})

/**
 * A node fixture that reports its own PID, so a test can assert the process is gone
 * rather than assert that we called kill.
 *
 * On win32 `startServer` launches through a shell (that is how `opencode.cmd` resolves),
 * so the fixture has to be a shell string — the same trusted, internal, constant-only
 * shape production uses. That shell layer is exactly what B17 is about: killing it
 * leaves this node process orphaned. Elsewhere there is no shell, so pass argv directly.
 */
function nodeFixture(source: string): { command: string; args?: string[] } {
  if (process.platform === 'win32') {
    return { command: `"${process.execPath}" -e "${source.replace(/"/g, '\\"')}"` }
  }
  return { command: process.execPath, args: ['-e', source] }
}

const writePid = (pidFile: string) => `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));`
const stayAlive = 'setInterval(function(){},1000);'
const printBanner = "console.log('opencode server listening on http://127.0.0.1:4599');"

function sleeperCommand(pidFile: string) {
  return nodeFixture(writePid(pidFile) + stayAlive)
}

function serverCommand(pidFile: string) {
  return nodeFixture(writePid(pidFile) + printBanner + stayAlive)
}

// A command that exits fast instead of hanging: `false` ignores argv.
function exiterCommand(): { command: string; args?: string[] } {
  if (process.platform === 'win32') return { command: `"${process.execPath}" -e "process.exit(3)"` }
  return { command: 'false' }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPid(dir: string): number {
  return Number(readFileSync(join(dir, 'pid'), 'utf8'))
}

/** Backstop only — never the operation an assertion depends on. */
function reap(dir: string): void {
  try {
    process.kill(readPid(dir))
  } catch {
    /* already gone, which is what the assertions require */
  }
  rmSync(dir, { recursive: true, force: true })
}

/** A child whose streams the test drives chunk by chunk. */
function fakeChild() {
  const child = new EventEmitter() as ChildProcess
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(child, { stdout, stderr, pid: 4321, exitCode: null, signalCode: null, kill: vi.fn(() => true) })
  return { child, stdout, stderr }
}

afterEach(() => {
  spawned.children.length = 0
  spawned.options.length = 0
})

describe('parseServerPort', () => {
  test('extracts the port from the startup banner', () => {
    expect(parseServerPort('opencode server listening on http://127.0.0.1:4599')).toBe(4599)
  })

  test('ignores unrelated lines', () => {
    expect(parseServerPort('Warning: OPENCODE_SERVER_PASSWORD is not set')).toBeNull()
  })

  test('handles a different host', () => {
    expect(parseServerPort('opencode server listening on http://0.0.0.0:1234')).toBe(1234)
  })

  test('returns null for empty input', () => {
    expect(parseServerPort('')).toBeNull()
  })

  test('extracts the port from a bracketed IPv6 host', () => {
    expect(parseServerPort('opencode server listening on http://[::1]:4599')).toBe(4599)
  })

  test('extracts the port from an https url', () => {
    expect(parseServerPort('listening on https://127.0.0.1:8443')).toBe(8443)
  })

  test('finds the banner inside a multi-line chunk', () => {
    expect(
      parseServerPort(['Warning: unsecured', 'opencode server listening on http://127.0.0.1:7777', ''].join('\n')),
    ).toBe(7777)
  })

  test('rejects a port outside the valid range', () => {
    expect(parseServerPort('listening on http://127.0.0.1:99999')).toBeNull()
    expect(parseServerPort('listening on http://127.0.0.1:0')).toBeNull()
  })
})

describe('createLineScanner', () => {
  test('joins a line split across chunks and never emits a partial one', () => {
    const lines: string[] = []
    const scanner = createLineScanner((line) => lines.push(line))
    scanner.push('opencode server listening on http://127.0')
    scanner.push('.0.1:45')
    expect(lines).toEqual([])
    scanner.push('99\n')
    expect(lines).toEqual(['opencode server listening on http://127.0.0.1:4599'])
  })

  test('splits a multi-line chunk and strips carriage returns', () => {
    const lines: string[] = []
    const scanner = createLineScanner((line) => lines.push(line))
    scanner.push('first\r\nsecond\r\n')
    expect(lines).toEqual(['first', 'second'])
  })

  test('flush emits an unterminated final line exactly once', () => {
    const lines: string[] = []
    const scanner = createLineScanner((line) => lines.push(line))
    scanner.push('no newline here')
    scanner.flush()
    scanner.flush()
    expect(lines).toEqual(['no newline here'])
  })

  test('caps retention for an unterminated line without losing the banner tail', () => {
    const lines: string[] = []
    const scanner = createLineScanner((line) => lines.push(line))
    scanner.push('x'.repeat(2_000_000))
    scanner.push('opencode server listening on http://127.0.0.1:4599\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.length).toBeLessThan(200_000)
    expect(parseServerPort(lines[0]!)).toBe(4599)
  })
})

describe('startServer banner parsing', () => {
  test.each([
    ['before the host', 'opencode server listening on http://', '127.0.0.1:4599\n'],
    ['before the port', 'opencode server listening on http://127.0.0.1', ':4599\n'],
    ['within the port digits', 'opencode server listening on http://127.0.0.1:45', '99\n'],
  ])('resolves the full endpoint when the banner splits %s', async (_name, head, tail) => {
    const { child, stdout } = fakeChild()
    const handle = startServer({ spawnFn: () => child, startupTimeoutMs: 2000 })
    stdout.write(head)
    await new Promise((r) => setImmediate(r))
    stdout.write(tail)
    expect((await handle).baseUrl).toBe('http://127.0.0.1:4599')
  })

  test('resolves once and ignores a later banner', async () => {
    const { child, stdout } = fakeChild()
    const handle = startServer({ spawnFn: () => child, startupTimeoutMs: 2000 })
    stdout.write('Warning: unrelated log line\n')
    stdout.write('opencode server listening on http://127.0.0.1:4599\n')
    stdout.write('opencode server listening on http://127.0.0.1:5000\n')
    expect((await handle).baseUrl).toBe('http://127.0.0.1:4599')
  })

  test('never joins halves from stdout and stderr', async () => {
    const { child, stdout, stderr } = fakeChild()
    const handle = startServer({ spawnFn: () => child, startupTimeoutMs: 150 })
    stdout.write('opencode server listening on http://127.0.0.1:45')
    stderr.write('99\n')
    await expect(handle).rejects.toThrow('timed out waiting for the startup banner')
  })

  test('accepts an unterminated banner when the stream ends', async () => {
    const { child, stdout } = fakeChild()
    const handle = startServer({ spawnFn: () => child, startupTimeoutMs: 2000 })
    stdout.end('opencode server listening on http://127.0.0.1:4599')
    expect((await handle).baseUrl).toBe('http://127.0.0.1:4599')
  })

  test('an exit before the banner still rejects', async () => {
    const { child } = fakeChild()
    const handle = startServer({ spawnFn: () => child, startupTimeoutMs: 2000 })
    await new Promise((r) => setImmediate(r))
    child.emit('exit', 3)
    await expect(handle).rejects.toThrow('process exited with code 3')
  })
})

describe('startServer process ownership', () => {
  test('stop terminates the process we started, not just its launcher', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'startserver-stop-'))
    try {
      const handle = await startServer({ ...serverCommand(join(dir, 'pid')), startupTimeoutMs: 10_000 })
      const pid = readPid(dir)
      expect(alive(pid)).toBe(true)
      await handle.stop()
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 })
      // Repeated stop is safe and stays resolved.
      await handle.stop()
    } finally {
      reap(dir)
    }
  }, 30_000)

  test('the startup timeout terminates the process we started', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'startserver-timeout-'))
    try {
      await expect(
        // Long enough for the fixture to boot and record its PID, then time out.
        startServer({ ...sleeperCommand(join(dir, 'pid')), startupTimeoutMs: 3000 }),
      ).rejects.toThrow('timed out waiting for the startup banner')
      const pid = readPid(dir)
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 })
    } finally {
      reap(dir)
    }
  }, 30_000)

  test('does not kill the child when it exits on its own', async () => {
    await expect(startServer({ ...exiterCommand(), startupTimeoutMs: 5000 })).rejects.toThrow(
      'process exited with code',
    )
    expect(spawned.children).toHaveLength(1)
    expect(spawned.children[0]?.killed).toBe(false)
  }, 15_000)

  test('attaching to a server we do not own leaves it running', async () => {
    const server = createServer((_req, res) => { res.writeHead(200); res.end('{}') })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const handle = await attachServer(`http://127.0.0.1:${port}`)
      await handle.stop()
      expect(await handle.client.health()).toBe(true)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, 15_000)

  test('scrubs server-auth env from the spawned child', async () => {
    const savedU = process.env.OPENCODE_SERVER_USERNAME
    const savedP = process.env.OPENCODE_SERVER_PASSWORD
    process.env.OPENCODE_SERVER_USERNAME = 'someone'
    process.env.OPENCODE_SERVER_PASSWORD = 'secret'
    try {
      await expect(startServer({ ...exiterCommand(), startupTimeoutMs: 5000 })).rejects.toThrow(
        'process exited with code',
      )
      expect(spawned.options).toHaveLength(1)
      const env = (spawned.options[0] as { env?: NodeJS.ProcessEnv }).env
      expect(env).not.toHaveProperty('OPENCODE_SERVER_USERNAME')
      expect(env).not.toHaveProperty('OPENCODE_SERVER_PASSWORD')
      // Nothing else stripped: the rest of the parent env still passes through.
      expect(env?.PATH).toBe(process.env.PATH)
      // The parent env itself is untouched.
      expect(process.env.OPENCODE_SERVER_PASSWORD).toBe('secret')
    } finally {
      if (savedU === undefined) delete process.env.OPENCODE_SERVER_USERNAME
      else process.env.OPENCODE_SERVER_USERNAME = savedU
      if (savedP === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
      else process.env.OPENCODE_SERVER_PASSWORD = savedP
    }
  }, 15_000)
})
