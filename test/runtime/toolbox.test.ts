import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  ensureToolbox,
  readToolboxPackages,
  TOOLBOX_DIR,
  TOOLBOX_PYTHON,
  TOOLBOX_SOURCES,
  toolboxEnv,
  toolboxPathEnv,
  type CommandRunner,
} from '../../src/runtime/toolbox.js'
import { workspaceNote } from '../../src/runtime/workspace-note.js'

const REPO = process.cwd()
const dirs: string[] = []

/** The toolbox is read-only once built; tests make it writable again to clean up. */
async function unlock(dir: string): Promise<void> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  for (const e of [{ parentPath: dir, name: '', isSymbolicLink: () => false }, ...entries]) {
    if (!e.isSymbolicLink()) await chmod(join(e.parentPath, e.name), 0o755).catch(() => {})
  }
}

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await unlock(d)
    await rm(d, { recursive: true, force: true })
  }
})

async function tempDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** A copy of the package files, so a test can change one. */
async function repoCopy(): Promise<string> {
  const root = await tempDir('toolbox-repo-')
  for (const f of Object.values(TOOLBOX_SOURCES)) {
    await mkdir(join(root, f, '..'), { recursive: true })
    await cp(join(REPO, f), join(root, f))
  }
  return root
}

/** Stands in for npm and uv: records each command and leaves what a real one would. */
function fakeRunner(fail: { uv?: boolean; npm?: boolean } = {}) {
  const calls: string[] = []
  const run: CommandRunner = async (command, args, cwd) => {
    calls.push(`${command} ${args.slice(0, 2).join(' ')}`)
    if (command === 'npm') {
      if (fail.npm) throw new Error('npm ci exited with 1: network down')
      await mkdir(join(cwd, 'node_modules', '.bin'), { recursive: true })
      await writeFile(join(cwd, 'node_modules', 'zod.js'), 'export {}')
      await writeFile(join(cwd, 'node_modules', '.bin', 'tsx'), '#!/bin/sh\n', { mode: 0o755 })
    } else if (command === 'uv') {
      if (fail.uv) throw Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' })
      if (args[0] === 'venv') await mkdir(join(args[args.length - 1]!, 'bin'), { recursive: true })
    }
  }
  return { run, calls }
}

const noSwitch = {} as NodeJS.ProcessEnv

describe('ensureToolbox', () => {
  test('switched off, there is no toolbox and nothing runs', async () => {
    const { run, calls } = fakeRunner()
    expect(await ensureToolbox(await tempDir('ws-'), { repoRoot: REPO, onWarning: () => {}, run, env: { ARENA_TOOLBOX: 'off' } })).toBeNull()
    expect(calls).toEqual([])
  })

  test('builds once from the locked package files, read-only, and links node_modules at the workspace root', async () => {
    const ws = await tempDir('ws-')
    const { run, calls } = fakeRunner()
    const warnings: string[] = []
    const tb = (await ensureToolbox(ws, { repoRoot: REPO, onWarning: (m) => warnings.push(m), run, env: noSwitch }))!
    expect(calls).toEqual(['npm ci --ignore-scripts', `uv venv --quiet`, 'uv pip install'])
    expect(tb.hasPython).toBe(true)
    expect(tb.node).toEqual(['express', 'fastify', 'tsx', 'typescript', 'vitest', 'zod'])
    expect(tb.python).toEqual(expect.arrayContaining(['numpy', 'pandas', 'requests', 'beautifulsoup4', 'pytest']))
    expect(tb.binDirs).toEqual([join(tb.root, 'python', 'bin'), join(tb.root, 'node', 'node_modules', '.bin')])
    expect(warnings).toEqual([expect.stringMatching(/^Building the shared agent toolbox/)])
    // Read-only: an agent's pip or npm install cannot change what every agent shares.
    expect((await stat(join(tb.root, 'node', 'node_modules', 'zod.js'))).mode & 0o222).toBe(0)
    // Without write bits, but commands keep their execute bits.
    if (process.platform !== 'win32') expect((await stat(join(tb.root, 'node', 'node_modules', '.bin', 'tsx'))).mode & 0o777).toBe(0o555)
    expect(await readlink(join(ws, 'node_modules'))).toBe(join(TOOLBOX_DIR, 'node', 'node_modules'))

    // Built: the next run finds it as it is.
    const again = fakeRunner()
    expect((await ensureToolbox(ws, { repoRoot: REPO, onWarning: () => {}, run: again.run, env: noSwitch }))!.root).toBe(tb.root)
    expect(again.calls).toEqual([])
  })

  test('the Python part uses the image Python and its hash-locked wheels only', async () => {
    const seen: string[][] = []
    const run: CommandRunner = async (command, args, cwd) => {
      seen.push([command, ...args])
      if (command === 'npm') await mkdir(join(cwd, 'node_modules', '.bin'), { recursive: true })
    }
    await ensureToolbox(await tempDir('ws-'), { repoRoot: REPO, onWarning: () => {}, run, env: noSwitch })
    expect(seen.find((a) => a[1] === 'venv')).toEqual(expect.arrayContaining(['--seed', '--python', TOOLBOX_PYTHON]))
    expect(seen.find((a) => a[1] === 'pip')).toEqual(expect.arrayContaining(['--require-hashes', '--only-binary', ':all:', '--no-deps', join(REPO, TOOLBOX_SOURCES.pythonLock)]))
  })

  test('a changed package file rebuilds it', async () => {
    const ws = await tempDir('ws-')
    const repo = await repoCopy()
    await ensureToolbox(ws, { repoRoot: repo, onWarning: () => {}, run: fakeRunner().run, env: noSwitch })
    await writeFile(join(repo, TOOLBOX_SOURCES.pythonIn), (await readFile(join(repo, TOOLBOX_SOURCES.pythonIn), 'utf8')) + 'sympy\n')
    const second = fakeRunner()
    const tb = (await ensureToolbox(ws, { repoRoot: repo, onWarning: () => {}, run: second.run, env: noSwitch }))!
    expect(second.calls).toHaveLength(3)
    expect(tb.python).toContain('sympy')
    expect((await readdir(ws)).filter((n) => n.includes('.building-'))).toEqual([])
  })

  test('without uv the Node part still serves, and the warning says why', async () => {
    const warnings: string[] = []
    const tb = (await ensureToolbox(await tempDir('ws-'), { repoRoot: REPO, onWarning: (m) => warnings.push(m), run: fakeRunner({ uv: true }).run, env: noSwitch }))!
    expect(tb.hasPython).toBe(false)
    expect(tb.python).toEqual([])
    expect(tb.binDirs).toEqual([join(tb.root, 'node', 'node_modules', '.bin')])
    expect(warnings.some((w) => /Python packages were not installed .*uv/.test(w))).toBe(true)
  })

  test('a failed build leaves no toolbox and no half-built folder, and the run goes ahead without one', async () => {
    const ws = await tempDir('ws-')
    const warnings: string[] = []
    expect(await ensureToolbox(ws, { repoRoot: REPO, onWarning: (m) => warnings.push(m), run: fakeRunner({ npm: true }).run, env: noSwitch })).toBeNull()
    expect(await readdir(ws)).toEqual([])
    expect(warnings.at(-1)).toMatch(/^No shared toolbox for this run: npm ci exited with 1/)
  })

  test('leaves a node_modules it did not make alone, and says imports will not find the toolbox', async () => {
    const ws = await tempDir('ws-')
    await mkdir(join(ws, 'node_modules'))
    const warnings: string[] = []
    expect(await ensureToolbox(ws, { repoRoot: REPO, onWarning: (m) => warnings.push(m), run: fakeRunner().run, env: noSwitch })).not.toBeNull()
    expect((await lstat(join(ws, 'node_modules'))).isSymbolicLink()).toBe(false)
    expect(warnings.some((w) => /is not the toolbox's link/.test(w))).toBe(true)
  })
})

describe('toolbox environment', () => {
  const tb = { root: '/tb', binDirs: ['/tb/python/bin', '/tb/node/node_modules/.bin'], python: [], node: [], hasPython: true }

  test('puts the toolbox commands first on PATH, keeping the rest', () => {
    expect(toolboxEnv({ PATH: '/usr/bin', HOME: '/h' }, tb)).toEqual({ PATH: ['/tb/python/bin', '/tb/node/node_modules/.bin', '/usr/bin'].join(delimiter), HOME: '/h' })
    expect(toolboxPathEnv({ Path: 'C:\\Windows' }, tb)).toEqual({ Path: ['/tb/python/bin', '/tb/node/node_modules/.bin', 'C:\\Windows'].join(delimiter) })
  })

  test('without a toolbox nothing changes', () => {
    const base = { PATH: '/usr/bin' }
    expect(toolboxEnv(base, null)).toBe(base)
    expect(toolboxPathEnv(base, null)).toEqual({})
  })
})

describe('workspace note', () => {
  test('names the disk limit, and the team total for a team', () => {
    expect(workspaceNote({ diskLimitBytes: 1_073_741_824, teamSize: null, packages: null }))
      .toBe('Disk: your workspace may use up to 1.0 GiB, each file counted as at least 4 KiB. Past that your work scores 0, so delete what you no longer need, such as packages you installed.')
    expect(workspaceNote({ diskLimitBytes: 1_073_741_824, teamSize: 4, packages: null }))
      .toMatch(/^Disk: the team's shared folder may use up to 4\.0 GiB \(1\.0 GiB per member\)/)
  })

  test('lists what is already installed and how to add more', async () => {
    const note = workspaceNote({ diskLimitBytes: 1_073_741_824, teamSize: null, packages: await readToolboxPackages(REPO) })
    expect(note).toContain('`python3` with numpy, pandas, scipy, matplotlib, pyarrow, duckdb, pytest, requests, beautifulsoup4')
    expect(note).toContain('the Node packages express, fastify, tsx, typescript, vitest, zod')
    expect(note).toContain('`python3 -m pip install --target .pylib <name>` and run with `PYTHONPATH=.pylib`')
    expect(workspaceNote({ diskLimitBytes: 1024, teamSize: null, packages: { python: [], node: ['zod'] } })).not.toContain('python3` with')
  })
})
