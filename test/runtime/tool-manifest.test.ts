import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  REQUIRED_TOOLS,
  agentImageTag,
  buildToolManifest,
  computeToolchainId,
  digestFolder,
  parseImageInventory,
  renderToolsMarkdown,
  type ImageInventory,
} from '../../src/runtime/tool-manifest.js'

const inventory: ImageInventory = {
  schemaVersion: 1,
  toolchainId: 'abc123def4567890',
  python: { version: '3.11.2', venv: '/opt/arena/venv', executable: '/opt/arena/venv/bin/python' },
  tools: [
    { name: 'python3', version: '3.11.2', executable: '/opt/arena/venv/bin/python' },
    { name: 'node', version: '24.15.0', executable: '/usr/local/bin/node' },
    { name: 'git', version: '2.39.5', executable: '/usr/bin/git' },
    { name: 'opencode', version: '1.18.21', executable: '/usr/local/bin/opencode' },
    { name: 'rg', version: '13.0.0', executable: '/usr/bin/rg' },
  ],
  pythonPackages: [
    { name: 'numpy', version: '2.3.3' },
    { name: 'pandas', version: '2.3.2' },
  ],
}

describe('toolchain identity', () => {
  test('is stable across line endings and changes with any toolchain file', () => {
    const a = computeToolchainId(['FROM x\nRUN y\n', 'numpy==1 --hash=sha256:aa\n', 'print(1)\n'])
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(computeToolchainId(['FROM x\r\nRUN y\r\n', 'numpy==1 --hash=sha256:aa\r\n', 'print(1)\r\n'])).toBe(a)
    expect(computeToolchainId(['FROM x\nRUN y\n', 'numpy==2 --hash=sha256:aa\n', 'print(1)\n'])).not.toBe(a)
    // Moving bytes between files is a different toolchain, not the same concatenation.
    expect(computeToolchainId(['FROM x\nRUN y\nnumpy==1 --hash=sha256:aa\n', '', 'print(1)\n'])).not.toBe(a)
  })

  test('the image tag names the toolchain instead of floating on latest', () => {
    expect(agentImageTag('abc123def4567890')).toBe('agent-arena:tc-abc123def4567890')
  })
})

describe('image inventory', () => {
  test('parses what the image recorded at build', () => {
    expect(parseImageInventory(JSON.stringify(inventory), inventory.toolchainId)).toEqual(inventory)
  })

  test('refuses an image built from a different toolchain', () => {
    expect(() => parseImageInventory(JSON.stringify(inventory), 'ffffffffffffffff')).toThrow(/built from toolchain abc123def4567890, expected ffffffffffffffff/)
  })

  test('names every required tool the image lacks', () => {
    const lacking = { ...inventory, tools: inventory.tools.filter((t) => t.name !== 'python3' && t.name !== 'git') }
    expect(() => parseImageInventory(JSON.stringify(lacking), inventory.toolchainId)).toThrow(/missing required tools: python3, git/)
    expect(REQUIRED_TOOLS).toEqual(['python3', 'node', 'git', 'opencode', 'rg'])
  })

  test('refuses malformed inventory instead of guessing', () => {
    expect(() => parseImageInventory('not json', inventory.toolchainId)).toThrow(/inventory/)
    expect(() => parseImageInventory('{"schemaVersion":2}', inventory.toolchainId)).toThrow(/inventory/)
  })
})

describe('runtime tool manifest', () => {
  const manifest = buildToolManifest({
    runId: 'run-1',
    containerId: 'arena-run-1-0',
    inventory,
    data: [{ name: 'context', mountPath: '/context', digest: 'sha256:0f', note: null }],
    packageInstall: 'not_enforced',
  })

  test('carries the image inventory, the run and mounts, and an honest policy', () => {
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      runId: 'run-1',
      containerId: 'arena-run-1-0',
      toolchainId: inventory.toolchainId,
      tools: inventory.tools,
      pythonPackages: inventory.pythonPackages,
      data: [{ name: 'context', mountPath: '/context', digest: 'sha256:0f', note: null }],
      policy: { packageInstall: 'not_enforced', dataAccess: 'preapproved' },
    })
  })

  test('refuses host paths and credential locations', () => {
    for (const mountPath of ['C:\\Users\\me\\research', '/root/.local/share/opencode', 'relative/dir']) {
      expect(() => buildToolManifest({
        runId: 'r', containerId: 'c', inventory, packageInstall: 'not_enforced',
        data: [{ name: 'x', mountPath, digest: null, note: null }],
      })).toThrow(/container path/)
    }
    const leaky = { ...inventory, tools: [...inventory.tools, { name: 'auth', version: '1', executable: '/root/.local/share/opencode/auth.json' }] }
    expect(() => buildToolManifest({ runId: 'r', containerId: 'c', inventory: leaky, data: [], packageInstall: 'not_enforced' })).toThrow(/credential/)
  })

  test('markdown tells agents what exists and not to install, without overstating enforcement', () => {
    const md = renderToolsMarkdown(manifest)
    expect(md).toContain('/opt/arena/venv/bin/python')
    expect(md).toContain('numpy 2.3.3')
    expect(md).toContain('/context')
    expect(md).toMatch(/do not install packages/i)
    expect(md).toMatch(/not enforced/i)
    const enforced = renderToolsMarkdown({ ...manifest, policy: { ...manifest.policy, packageInstall: 'denied' } })
    expect(enforced).not.toMatch(/not enforced/i)
  })
})

describe('folder digest', () => {
  test('changes with content, not with where the folder lives', async () => {
    const make = (text: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'digest-'))
      mkdirSync(join(dir, 'sub'))
      writeFileSync(join(dir, 'a.txt'), 'alpha')
      writeFileSync(join(dir, 'sub', 'b.txt'), text)
      return dir
    }
    const one = make('beta')
    const two = make('beta')
    const three = make('gamma')
    try {
      const d1 = await digestFolder(one)
      expect(d1.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect((await digestFolder(two)).digest).toBe(d1.digest)
      expect((await digestFolder(three)).digest).not.toBe(d1.digest)
    } finally {
      for (const d of [one, two, three]) rmSync(d, { recursive: true, force: true })
    }
  })

  test('reports a folder over the limits instead of hashing it partially', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'digest-big-'))
    try {
      for (let i = 0; i < 3; i++) writeFileSync(join(dir, `f${i}.txt`), 'x')
      expect(await digestFolder(dir, { maxFiles: 2, maxBytes: 1024 })).toEqual({ digest: null, note: 'not hashed: more than 2 files' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('research lock', () => {
  test('pins every approved package to an exact version with hashes', () => {
    const wanted = readFileSync('docker/research-requirements.in', 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    const lock = readFileSync('docker/research-requirements.lock', 'utf8')
    for (const name of wanted) {
      expect(lock).toMatch(new RegExp(`^${name}==\\d[^\\s]*\\s*\\\\\\s*\\n\\s+--hash=sha256:[0-9a-f]{64}`, 'mi'))
    }
    const pins = lock.split('\n').filter((l) => /^[a-z0-9]/i.test(l))
    expect(pins.every((l) => /==/.test(l))).toBe(true)
  })
})
