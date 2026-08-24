import { describe, expect, test, vi } from 'vitest'
import { ensureImage } from '../../../src/runtime/docker/image.js'

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

  test('throws with the build output when the build fails', async () => {
    const fake = vi.fn(async (args: string[]) =>
      args[0] === 'image' ? missing : { stdout: '', stderr: 'boom: no space left', code: 1 },
    )
    await expect(
      ensureImage('agent-arena:latest', '/ctx', 'docker/Dockerfile.agent', fake),
    ).rejects.toThrow(/no space left/)
  })
})
