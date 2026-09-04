import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { parseServerPort, startServer } from '../../../src/runtime/opencode/server.js'

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

// A command that never prints the banner. Win32 spawn uses a shell, so the
// command can be a whole shell string; elsewhere it must be one executable,
// so use `yes` (ignores argv, prints forever, never the banner).
function sleeperCommand(pidFile: string): string {
  if (process.platform === 'win32') {
    const code = `require('node:fs').writeFileSync('${pidFile.replace(/\\/g, '/')}',String(process.pid));setInterval(function(){},1000)`
    return `"${process.execPath}" -e "${code}"`
  }
  return 'yes'
}

// A command that exits fast instead of hanging: `false` ignores argv.
function exiterCommand(): string {
  if (process.platform === 'win32') return `"${process.execPath}" -e "process.exit(3)"`
  return 'false'
}

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
})

describe('startServer startup timeout', () => {
  test('kills the child when the startup banner never arrives', async () => {
    spawned.children.length = 0
    const dir = mkdtempSync(join(tmpdir(), 'startserver-'))
    try {
      await expect(
        startServer({ command: sleeperCommand(join(dir, 'pid')), startupTimeoutMs: 100 }),
      ).rejects.toThrow('timed out waiting for the startup banner')
      expect(spawned.children).toHaveLength(1)
      const child = spawned.children[0]
      expect(child?.killed).toBe(true)
      await vi.waitFor(
        () => expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true),
        { timeout: 5000 },
      )
    } finally {
      try {
        // On win32 the shell child dies but its node grandchild may outlive it.
        process.kill(Number(readFileSync(join(dir, 'pid'), 'utf8')))
      } catch {
        // Already dead — nothing to clean up.
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  test('does not kill the child when it exits on its own', async () => {
    spawned.children.length = 0
    spawned.options.length = 0
    await expect(startServer({ command: exiterCommand(), startupTimeoutMs: 5000 })).rejects.toThrow(
      'process exited with code',
    )
    expect(spawned.children).toHaveLength(1)
    expect(spawned.children[0]?.killed).toBe(false)
  }, 15_000)

  test('scrubs server-auth env from the spawned child', async () => {
    const savedU = process.env.OPENCODE_SERVER_USERNAME
    const savedP = process.env.OPENCODE_SERVER_PASSWORD
    process.env.OPENCODE_SERVER_USERNAME = 'someone'
    process.env.OPENCODE_SERVER_PASSWORD = 'secret'
    spawned.children.length = 0
    spawned.options.length = 0
    try {
      await expect(startServer({ command: exiterCommand(), startupTimeoutMs: 5000 })).rejects.toThrow(
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
