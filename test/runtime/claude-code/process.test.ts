import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'vitest'
import {
  dockerExecArgs,
  dockerExecLauncher,
  KILL_GROUP_SCRIPT,
  localLauncher,
  pidFileFor,
  PROBE_GROUP_SCRIPT,
  ClaudeCliMissingError,
} from '../../../src/runtime/claude-code/process.js'
import type { DockerFn } from '../../../src/runtime/docker/cli.js'

const handle = { agentId: 'a1', workspacePath: '/work/a1', baseUrl: '' }
const request = {
  args: ['-p', '--model=opus'],
  settings: { DISABLE_AUTOUPDATER: '1', CLAUDE_CONFIG_DIR: '/tmp/arena-claude/a1' },
  secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'secret-token-value-1234567890' },
  cwd: '/work/a1',
  key: 'a1-11111111',
}

describe('docker exec launch', () => {
  test('starts the CLI as a recorded session leader; secrets are named, never valued, in argv', () => {
    const args = dockerExecArgs('arena-run-0', request)
    expect(args.slice(0, 4)).toEqual(['exec', '-i', '-w', '/work/a1'])
    expect(args).toEqual(expect.arrayContaining(['-e', 'DISABLE_AUTOUPDATER=1', '-e', 'CLAUDE_CODE_OAUTH_TOKEN']))
    expect(args.join(' ')).not.toContain('secret-token-value')
    const at = args.indexOf('arena-run-0')
    expect(args.slice(at + 1, at + 8)).toEqual(['setsid', '-w', 'sh', '-c', 'echo $$ > "$0" && exec claude "$@"', '/tmp/arena-claude-a1-11111111.pid', '-p'])
  })

  test('pid files only take safe keys', () => {
    expect(() => pidFileFor('../x')).toThrow(/unsafe/)
  })

  test('kill and probe go through the container, and a vanished container counts as stopped', async () => {
    const calls: string[][] = []
    let probeAnswer = { code: 0, stdout: '', stderr: '' }
    const run: DockerFn = async (args) => {
      calls.push(args)
      return args.includes(PROBE_GROUP_SCRIPT) ? probeAnswer : { code: 0, stdout: '', stderr: '' }
    }
    const spawned: { env: Record<string, string> }[] = []
    const launcher = dockerExecLauncher({
      containerFor: () => 'arena-run-0',
      run,
      baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'no' },
      spawnFn: ((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        spawned.push(opts)
        return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1 })
      }) as never,
    })
    const proc = launcher.launch(handle, request)
    expect(spawned[0]!.env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'secret-token-value-1234567890' })
    await proc.kill()
    expect(calls[0]).toEqual(['exec', 'arena-run-0', 'sh', '-c', KILL_GROUP_SCRIPT, '/tmp/arena-claude-a1-11111111.pid'])
    expect(await proc.probe()).toBe('running')
    probeAnswer = { code: 1, stdout: '', stderr: '' }
    expect(await proc.probe()).toBe('stopped')
    probeAnswer = { code: 1, stdout: '', stderr: 'Error response from daemon: No such container: arena-run-0' }
    expect(await proc.probe()).toBe('stopped')
    probeAnswer = { code: 125, stdout: '', stderr: 'Cannot connect to the Docker daemon' }
    expect(await proc.probe()).toBe('unknown')
  })
})

describe.skipIf(process.platform === 'win32')('local launch', () => {
  test('reports a missing CLI before spawning', () => {
    expect(() => localLauncher({ cliPath: () => null }).launch(handle, request)).toThrow(ClaudeCliMissingError)
  })

  test('a token arrives on descriptor 3; inherited Claude variables do not arrive at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arena-fake-claude-'))
    const cli = join(dir, 'claude')
    writeFileSync(cli, [
      `#!${process.execPath}`,
      "const fs = require('fs')",
      "const token = fs.readFileSync(3, 'utf8')",
      "const seen = Object.keys(process.env).filter((k) => /^(ANTHROPIC|CLAUDE)/.test(k)).sort()",
      "process.stdout.write(JSON.stringify({ token, seen, args: process.argv.slice(2), cwd: process.cwd() }) + '\\n')",
    ].join('\n'))
    chmodSync(cli, 0o755)
    const proc = localLauncher({
      cliPath: () => cli,
      baseEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-api', CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'other' },
    }).launch(handle, { args: ['-p'], settings: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' }, secrets: {}, token: 'fd-token-1234567890abc', cwd: dir, key: 'k' })
    let out = ''
    proc.stdout.on('data', (d) => { out += String(d) })
    const exit = await proc.exited
    expect(exit.code).toBe(0)
    const seen = JSON.parse(out) as { token: string; seen: string[]; args: string[] }
    expect(seen.token).toBe('fd-token-1234567890abc')
    expect(seen.seen).toEqual(['CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'])
    expect(seen.args).toEqual(['-p'])
    expect(await proc.probe()).toBe('stopped')
  })

  test('kill ends the whole process group, children included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arena-fake-claude-'))
    const cli = join(dir, 'claude')
    writeFileSync(cli, `#!/bin/sh\nsleep 30 &\nsleep 30\n`)
    chmodSync(cli, 0o755)
    const proc = localLauncher({ cliPath: () => cli }).launch(handle, { ...request, secrets: {}, cwd: dir })
    await new Promise((r) => setTimeout(r, 100))
    expect(await proc.probe()).toBe('running')
    await proc.kill()
    await proc.exited
    await new Promise((r) => setTimeout(r, 100))
    expect(await proc.probe()).toBe('stopped')
  })
})
