import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { AgentHandle, Sandbox } from './sandbox.js'

/**
 * The shared agent toolbox: Python and Node packages installed once, read-only, so agents can
 * use them without installing into their own workspace.
 *
 * Built from the same package files the Docker agent image installs (docker/Dockerfile.agent):
 * the hash-locked research requirements and the integrity-locked Node packages. Docker agents
 * get the image's copy; local runs get this one, under the workspace root beside the grader's
 * folder, with its commands first on agents' PATH and a `node_modules` link at the workspace
 * root, which Node's module resolution reaches from any workspace below it.
 */

/** The toolbox's folder under a workspace root. */
export const TOOLBOX_DIR = '.arena-toolbox'

/**
 * Written at the root of every real workspace. npm looks upward for a project, and without one it
 * would reach the toolbox link above the workspace and replace it with an install of its own,
 * breaking imports for every agent (seen in a local check, 16 November 2026). Stopped here, an
 * agent's `npm install` lands in its own workspace, and the toolbox stays importable above it.
 */
export const NPM_STOP_FILE = 'package.json'
export const NPM_STOP_CONTENT = `${JSON.stringify({
  private: true,
  description: 'npm installs packages for this workspace here. The shared toolbox packages are already importable.',
}, null, 2)}\n`

/** Writes the npm stop file unless the workspace already has a package.json. */
export async function writeNpmStop(sandbox: Pick<Sandbox, 'readFile' | 'writeFile'>, handle: AgentHandle): Promise<void> {
  if ((await sandbox.readFile(handle, NPM_STOP_FILE)) === null) await sandbox.writeFile(handle, NPM_STOP_FILE, NPM_STOP_CONTENT)
}

/** The package files, relative to the repository. Editing one rebuilds the toolbox and names a new image. */
export const TOOLBOX_SOURCES = {
  pythonIn: 'docker/research-requirements.in',
  pythonLock: 'docker/research-requirements.lock',
  nodePackage: 'docker/toolbox-node/package.json',
  nodeLock: 'docker/toolbox-node/package-lock.json',
} as const

/** The image's Python, which research-requirements.lock is resolved for. */
export const TOOLBOX_PYTHON = '3.11'

/** Set to `off` to start runs without a toolbox (the test suite does, so it never downloads packages). */
export const TOOLBOX_SWITCH = 'ARENA_TOOLBOX'

const STAMP_FILE = '.stamp'
const BUILD_TIMEOUT_MS = 15 * 60_000

/** The top-level packages, as the package files name them. */
export interface ToolboxPackages {
  python: string[]
  node: string[]
}

export interface Toolbox extends ToolboxPackages {
  /** The toolbox folder, by its real path; read-only once built. */
  root: string
  /** Folders to put first on agents' PATH: the venv's commands (absent when Python could not be built) and the Node packages'. */
  binDirs: string[]
  /** Whether the Python part was built; it needs `uv`. */
  hasPython: boolean
}

/** Runs a command to completion; rejects with the tail of its error output. */
export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<void>

/** The package names in the package files, without versions. */
export async function readToolboxPackages(repoRoot: string): Promise<ToolboxPackages> {
  const requirements = await readFile(join(repoRoot, TOOLBOX_SOURCES.pythonIn), 'utf8')
  const nodePackage = JSON.parse(await readFile(join(repoRoot, TOOLBOX_SOURCES.nodePackage), 'utf8')) as { dependencies?: Record<string, string> }
  return {
    python: requirements.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter((l) => l.length > 0),
    node: Object.keys(nodePackage.dependencies ?? {}).sort(),
  }
}

/** A hash of the package files: the toolbox is rebuilt when it changes. */
async function sourcesStamp(repoRoot: string): Promise<string> {
  const h = createHash('sha256')
  for (const file of Object.values(TOOLBOX_SOURCES)) h.update(file).update('\0').update(await readFile(join(repoRoot, file))).update('\0')
  return h.digest('hex')
}

const binDir = process.platform === 'win32' ? 'Scripts' : 'bin'

function toolboxAt(root: string, packages: ToolboxPackages, hasPython: boolean): Toolbox {
  return {
    ...packages,
    python: hasPython ? packages.python : [],
    root,
    hasPython,
    binDirs: [...(hasPython ? [join(root, 'python', binDir)] : []), join(root, 'node', 'node_modules', '.bin')],
  }
}

export const runCommand: CommandRunner = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32', windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + String(d)).slice(-2000) })
    const timer = setTimeout(() => child.kill(), BUILD_TIMEOUT_MS)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args[0] ?? ''} exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`))
    })
  })

/**
 * Removes every write bit under `dir`, or gives the owner write back; read and execute bits are
 * kept, so commands stay runnable. Links are left alone.
 */
async function setWritable(dir: string, writable: boolean): Promise<void> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  const paths = [...entries.filter((e) => !e.isSymbolicLink()).map((e) => join(e.parentPath, e.name)), dir]
  // Folders last when locking, first when unlocking, so every entry stays reachable.
  for (const path of writable ? paths.reverse() : paths) {
    const mode = (await lstat(path).catch(() => null))?.mode
    if (mode === undefined) continue
    await chmod(path, writable ? (mode | 0o200) & 0o7777 : mode & 0o7555).catch(() => {})
  }
}

async function removeTree(dir: string): Promise<void> {
  await setWritable(dir, true)
  await rm(dir, { recursive: true, force: true })
}

/** Links `<workspaceRoot>/node_modules` to the toolbox's packages, unless something else is there. */
async function linkNodeModules(workspaceRoot: string, onWarning: (m: string) => void): Promise<void> {
  const link = join(workspaceRoot, 'node_modules')
  // Relative, so the root can move; a Windows junction needs an absolute target.
  const relative = join(TOOLBOX_DIR, 'node', 'node_modules')
  const target = process.platform === 'win32' ? join(workspaceRoot, relative) : relative
  const existing = await lstat(link).catch(() => null)
  if (existing?.isSymbolicLink() && (await readlink(link)) === target) return
  if (existing) {
    onWarning(`${link} already exists and is not the toolbox's link, so agents' imports will not find the toolbox's Node packages.`)
    return
  }
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

async function build(repoRoot: string, final: string, stamp: string, run: CommandRunner, onWarning: (m: string) => void): Promise<boolean> {
  const staging = `${final}.building-${randomBytes(4).toString('hex')}`
  try {
    const node = join(staging, 'node')
    await mkdir(node, { recursive: true })
    await copyFile(join(repoRoot, TOOLBOX_SOURCES.nodePackage), join(node, 'package.json'))
    await copyFile(join(repoRoot, TOOLBOX_SOURCES.nodeLock), join(node, 'package-lock.json'))
    // Exactly the lock, every tarball checked against its integrity hash, no package scripts run.
    await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], node)

    let hasPython = true
    try {
      // The image's Python and the image's lock: hash-checked wheels only, nothing resolved here.
      // --seed adds pip, which agents use to install extra packages into their own folder.
      await run('uv', ['venv', '--quiet', '--seed', '--python', TOOLBOX_PYTHON, join(staging, 'python')], staging)
      await run('uv', ['pip', 'install', '--quiet', '--python', join(staging, 'python'), '--require-hashes', '--only-binary', ':all:', '--no-deps',
        '-r', join(repoRoot, TOOLBOX_SOURCES.pythonLock)], staging)
    } catch (e) {
      hasPython = false
      await rm(join(staging, 'python'), { recursive: true, force: true })
      onWarning(`The toolbox's Python packages were not installed (${(e as Error).message}); it needs uv (https://docs.astral.sh/uv/). Node packages are available.`)
    }

    await writeFile(join(staging, STAMP_FILE), JSON.stringify({ stamp, hasPython }), 'utf8')
    await setWritable(staging, false)
    if (await lstat(final).catch(() => null)) await removeTree(final)
    await rename(staging, final)
    return hasPython
  } catch (e) {
    await removeTree(staging).catch(() => {})
    throw e
  }
}

async function builtStamp(final: string): Promise<{ stamp: string; hasPython: boolean } | null> {
  try {
    return JSON.parse(await readFile(join(final, STAMP_FILE), 'utf8')) as { stamp: string; hasPython: boolean }
  } catch {
    return null
  }
}

const building = new Map<string, Promise<Toolbox | null>>()

/**
 * The toolbox for a workspace root, built first when it is missing or its package files have
 * changed. Null when it cannot be built or is switched off: runs then go ahead without it.
 */
export function ensureToolbox(
  workspaceRoot: string,
  opts: { repoRoot: string; onWarning: (message: string) => void; run?: CommandRunner; env?: NodeJS.ProcessEnv },
): Promise<Toolbox | null> {
  if ((opts.env ?? process.env)[TOOLBOX_SWITCH] === 'off') return Promise.resolve(null)
  const key = workspaceRoot
  const pending = building.get(key)
  if (pending) return pending
  const result = (async (): Promise<Toolbox | null> => {
    try {
      const final = join(workspaceRoot, TOOLBOX_DIR)
      const [stamp, packages] = await Promise.all([sourcesStamp(opts.repoRoot), readToolboxPackages(opts.repoRoot)])
      let built = await builtStamp(final)
      if (built?.stamp !== stamp) {
        opts.onWarning(`Building the shared agent toolbox in ${final}: once per workspace root, and again when its package files change. It downloads the pinned Python and Node packages.`)
        try {
          built = { stamp, hasPython: await build(opts.repoRoot, final, stamp, opts.run ?? runCommand, opts.onWarning) }
        } catch (e) {
          // Another process may have finished the same build first.
          built = await builtStamp(final)
          if (built?.stamp !== stamp) throw e
        }
      }
      await linkNodeModules(workspaceRoot, opts.onWarning)
      return toolboxAt(await realpath(final), packages, built.hasPython)
    } catch (e) {
      opts.onWarning(`No shared toolbox for this run: ${(e as Error).message}. Agents can still install packages in their own workspace.`)
      return null
    } finally {
      building.delete(key)
    }
  })()
  building.set(key, result)
  return result
}

/** An environment with the toolbox's commands first on PATH. */
export function toolboxEnv(base: NodeJS.ProcessEnv, toolbox: Toolbox | null): NodeJS.ProcessEnv {
  if (!toolbox) return base
  // Windows spells it Path; whatever key the base uses is the one to replace.
  const key = Object.keys(base).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...base, [key]: [...toolbox.binDirs, base[key] ?? ''].filter((p) => p.length > 0).join(delimiter) }
}

/** Just the PATH entry of `toolboxEnv`, for merging into another environment; empty without a toolbox. */
export function toolboxPathEnv(base: NodeJS.ProcessEnv, toolbox: Toolbox | null): Record<string, string> {
  if (!toolbox) return {}
  const env = toolboxEnv(base, toolbox)
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')!
  return { [key]: env[key]! }
}
