import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'vitest'
import {
  dockerExecArgs,
  dockerExecLauncher,
  KILL_GROUP_SCRIPT,
  LEADER_SCRIPT,
  writeSecretEnvFile,
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
  test('starts the CLI as the recorded group leader; secrets go only in an env file, never argv', () => {
    const args = dockerExecArgs('arena-run-0', request, '/tmp/arena-claude-env-x/env')
    expect(args.slice(0, 4)).toEqual(['exec', '-i', '-w', '/work/a1'])
    expect(args).toEqual(expect.arrayContaining(['-e', 'DISABLE_AUTOUPDATER=1', '--env-file', '/tmp/arena-claude-env-x/env']))
    expect(args.join(' ')).not.toMatch(/secret-token-value|CLAUDE_CODE_OAUTH_TOKEN/)
    const at = args.indexOf('arena-run-0')
    expect(args.slice(at + 1, at + 6)).toEqual(['sh', '-c', LEADER_SCRIPT, '/tmp/arena-claude-a1-11111111.pid', '-p'])
    expect(LEADER_SCRIPT).toContain('exec claude "$@"')
    expect(dockerExecArgs('c', { ...request, secrets: {} }, null)).not.toContain('--env-file')
  })

  test('the env file is 0600 in a private folder, holds only the secrets, and is gone once the CLI speaks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arena-envfile-test-'))
    const spawned: { args: string[]; env: Record<string, string>; child: EventEmitter & { stdout: PassThrough } }[] = []
    const launcher = dockerExecLauncher({
      containerFor: () => 'arena-run-0', envFileDir: dir,
      baseEnv: { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'inherited' },
      spawnFn: ((_cmd: string, args: string[], opts: { env: Record<string, string> }) => {
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1 })
        spawned.push({ args, env: opts.env, child })
        return child
      }) as never,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    })
    launcher.launch(handle, request)
    const { args, env, child } = spawned[0]!
    const file = args[args.indexOf('--env-file') + 1]!
    expect(readFileSync(file, 'utf8')).toBe('CLAUDE_CODE_OAUTH_TOKEN=secret-token-value-1234567890\n')
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700)
    }
    // Neither the docker client's command line nor its environment holds the token.
    expect(env).toEqual({ PATH: '/bin' })
    expect(JSON.stringify(args)).not.toContain('secret-token-value')
    child.stdout.write('{"type":"system"}\n')
    expect(existsSync(file)).toBe(false)
    expect(existsSync(dirname(file))).toBe(false)
  })

  test('an exec that never speaks still removes its env file when it ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arena-envfile-test-'))
    let child!: EventEmitter
    let args: string[] = []
    const launcher = dockerExecLauncher({
      containerFor: () => 'c', envFileDir: dir,
      spawnFn: ((_c: string, a: string[]) => { args = a; child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1 }); return child }) as never,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    })
    const proc = launcher.launch(handle, request)
    const file = args[args.indexOf('--env-file') + 1]!
    expect(existsSync(file)).toBe(true)
    child.emit('exit', 1, null)
    await proc.exited
    await new Promise((r) => setImmediate(r))
    expect(existsSync(file)).toBe(false)
  })

  test('refuses a secret an env file could not carry intact', () => {
    expect(() => writeSecretEnvFile({ CLAUDE_CODE_OAUTH_TOKEN: 'has space' })).toThrow(/cannot be passed/)
    expect(() => writeSecretEnvFile({ 'BAD NAME': 'x' })).toThrow(/cannot be passed/)
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
      envFileDir: mkdtempSync(join(tmpdir(), 'arena-envfile-test-')),
      run,
      baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'no' },
      spawnFn: ((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        spawned.push(opts)
        return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1 })
      }) as never,
    })
    const proc = launcher.launch(handle, request)
    expect(spawned[0]!.env).toEqual({ PATH: '/bin' })
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
