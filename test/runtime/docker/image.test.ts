import { describe, expect, test, vi } from 'vitest'
import { ensureImage, readImageInventory } from '../../../src/runtime/docker/image.js'

describe('readImageInventory', () => {
  const inventory = {
    schemaVersion: 1, toolchainId: 'abc',
    python: { version: '3.11.2', venv: '/opt/arena/venv', executable: '/opt/arena/venv/bin/python' },
    tools: ['python3', 'node', 'git', 'opencode'].map((name) => ({ name, version: '1', executable: `/usr/bin/${name}` })),
    pythonPackages: [],
  }

  test('reads the build-time inventory in a networkless throwaway container', async () => {
    let args: string[] = []
    const fake = vi.fn(async (a: string[]) => { args = a; return { stdout: JSON.stringify(inventory), stderr: '', code: 0 } })
    expect((await readImageInventory('agent-arena:tc-abc', 'abc', fake)).toolchainId).toBe('abc')
    expect(args.join(' ')).toBe('run --rm --network none --entrypoint cat agent-arena:tc-abc /opt/arena/toolchain.json')
  })

  test('an image without an inventory is refused with docker\'s reason', async () => {
    const fake = vi.fn(async () => ({ stdout: '', stderr: 'cat: /opt/arena/toolchain.json: No such file or directory', code: 1 }))
    await expect(readImageInventory('agent-arena:tc-abc', 'abc', fake)).rejects.toThrow(/Could not read the tool inventory from agent-arena:tc-abc: cat: .*No such file/)
  })
})

const ok = { stdout: 'sha256:abc', stderr: '', code: 0 }
const missing = { stdout: '', stderr: 'No such image', code: 1 }

describe('ensureImage', () => {
  test('does not build when the image already exists', async () => {
    const calls: string[][] = []
    const fake = vi.fn(async (args: string[]) => { calls.push(args); return ok })
    await ensureImage('agent-arena:latest', '/ctx', 'docker/Dockerfile.agent', fake)
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('image')
  })

  test('builds when the image is missing', async () => {
    const calls: string[][] = []
    const fake = vi.fn(async (args: string[]) => {
      calls.push(args)
      return args[0] === 'image' ? missing : ok
    })
    await ensureImage('agent-arena:latest', '/ctx', 'docker/Dockerfile.agent', fake)
    expect(calls.some((c) => c[0] === 'build')).toBe(true)
  })

  test('passes the tag, dockerfile and context to build', async () => {
    let buildArgs: string[] = []
    const fake = vi.fn(async (args: string[]) => {
      if (args[0] === 'build') buildArgs = args
      return args[0] === 'image' ? missing : ok
    })
    await ensureImage('agent-arena:latest', '/ctx', 'docker/Dockerfile.agent', fake)
    expect(buildArgs).toContain('agent-arena:latest')
    expect(buildArgs).toContain('docker/Dockerfile.agent')
    expect(buildArgs).toContain('/ctx')
  })

  test('builds a toolchain image with its identity as build arg and label', async () => {
    let buildArgs: string[] = []
    const fake = vi.fn(async (args: string[]) => {
      if (args[0] === 'build') buildArgs = args
      return args[0] === 'image' ? missing : ok
    })
    await ensureImage('agent-arena:tc-abc', '/ctx', 'docker/Dockerfile.agent', fake, { toolchainId: 'abc' })
    expect(buildArgs.join(' ')).toContain('--build-arg TOOLCHAIN_ID=abc')
    expect(buildArgs.join(' ')).toContain('--label arena.toolchain=abc')
  })

  test('accepts an existing image only when its label names the same toolchain', async () => {
    const labelled = (label: string) => vi.fn(async (args: string[]) => {
      expect(args).toContain('{{index .Config.Labels "arena.toolchain"}}')
      return { stdout: `${label}\n`, stderr: '', code: 0 }
    })
    await expect(ensureImage('agent-arena:tc-abc', '/ctx', 'd', labelled('abc'), { toolchainId: 'abc' })).resolves.toBeUndefined()
    await expect(ensureImage('agent-arena:tc-abc', '/ctx', 'd', labelled('other'), { toolchainId: 'abc' }))
      .rejects.toThrow(/agent-arena:tc-abc was built from toolchain "other", not "abc"/)
  })

  test('throws with the build output when the build fails', async () => {
    const fake = vi.fn(async (args: string[]) =>
      args[0] === 'image' ? missing : { stdout: '', stderr: 'boom: no space left', code: 1 },
    )
    await expect(
      ensureImage('agent-arena:latest', '/ctx', 'docker/Dockerfile.agent', fake),
    ).rejects.toThrow(/no space left/)
  })
})
