import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { captureSubmission, verifyCapture } from '../../src/engine/capture.js'
import { DockerSandbox } from '../../src/runtime/docker/sandbox.js'
import { LocalSandbox } from '../../src/runtime/local-sandbox.js'
import type { AgentHandle, Sandbox } from '../../src/runtime/sandbox.js'
import { WorkspaceEscapeError, resolveInWorkspace } from '../../src/runtime/workspace-path.js'

/**
 * The escape target is a harmless fixture this test creates beside the workspace. It
 * stands in for anything the orchestrator can reach and the agent cannot; no real file
 * of the user's is ever named, read or written here.
 */
const OUTSIDE_NAME = 'outside-fixture.txt'
const OUTSIDE_TEXT = 'sibling fixture the workspace must not reach'

/**
 * Set up synchronously at module scope, NOT in `beforeAll`.
 *
 * `test.skipIf` is evaluated while tests are collected, which happens before any hook
 * runs. A probe assigned in `beforeAll` is therefore still `false` when `skipIf` reads
 * it, and every file-link test is skipped unconditionally — passing the suite while
 * proving nothing, on every platform. Doing the probe here is what makes the skip
 * describe the machine instead of the hook order.
 */
const root = mkdtempSync(join(tmpdir(), 'workspace-links-'))
const outsideDir = join(root, 'outside')
const outsideFile = join(outsideDir, OUTSIDE_NAME)
mkdirSync(outsideDir, { recursive: true })
writeFileSync(outsideFile, OUTSIDE_TEXT, 'utf8')

/**
 * Windows creates directory junctions without elevation but refuses file symlinks unless
 * the account holds SeCreateSymbolicLink (Developer Mode, or admin).
 */
const fileLinksAvailable = (() => {
  const probe = join(root, 'probe-link')
  try {
    symlinkSync(outsideFile, probe, 'file')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
})()

if (!fileLinksAvailable) {
  // Printed so a run's skip count is attributable rather than mysterious.
  console.info(`file symlinks unavailable on ${process.platform}; directory-junction tests still run`)
}

afterAll(async () => {
  // Only ever inside the directory this file created.
  if (root.startsWith(tmpdir())) await rm(root, { recursive: true, force: true })
})

/** Directory links: 'junction' on win32 is the unprivileged equivalent of a dir symlink. */
async function linkDir(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

/**
 * Docker's host workspace is `<root>/shard-N/<agentId>`; the container path in the handle
 * is never touched by host reads.
 *
 * Goes through the real `provision`, with the container lifecycle as a typed in-memory
 * fake. Marking the workspace live by reaching into the private set instead would leave
 * the seeding and shard bookkeeping that `provision` performs untested, which is where a
 * containment gap could just as easily hide. No daemon is contacted.
 */
async function dockerFixture(dir: string, agentId: string) {
  const started: string[] = []
  const sandbox = new DockerSandbox({
    runId: 'links', root: dir, maxContainers: 1, image: 'fake', memory: '1g', cpus: 1,
    authFile: null,
    startContainer: async (shardIndex: number) => {
      started.push(`shard-${shardIndex}`)
      return { name: `fake-shard-${shardIndex}`, baseUrl: 'http://fake.invalid', shardIndex }
    },
    stopContainer: async () => {},
  })
  sandbox.planFor([agentId])
  const handle = await sandbox.provision(agentId, {})
  expect(started).toEqual(['shard-0'])
  // provision() returns the CONTAINER path; the host path is where the links go.
  expect(handle.workspacePath).toBe(`/work/${agentId}`)
  return { sandbox, handle, hostDir: join(dir, 'shard-0', agentId) }
}

describe('resolveInWorkspace', () => {
  test('accepts a normal nested path and rejects a textual escape', async () => {
    const dir = await mkdtemp(join(root, 'unit-'))
    await mkdir(join(dir, 'notes'), { recursive: true })
    await expect(resolveInWorkspace(dir, 'notes/a.md')).resolves.toBe(join(dir, 'notes', 'a.md'))
    await expect(resolveInWorkspace(dir, '../escape.txt')).rejects.toBeInstanceOf(WorkspaceEscapeError)
  })

  test('rejects a path whose ancestor directory is a link', async () => {
    const dir = await mkdtemp(join(root, 'unit-ancestor-'))
    await linkDir(outsideDir, join(dir, 'notes'))
    await expect(resolveInWorkspace(dir, `notes/${OUTSIDE_NAME}`)).rejects.toThrow(/crosses a link at "notes"/)
  })

  test('a missing path is not an escape', async () => {
    const dir = await mkdtemp(join(root, 'unit-missing-'))
    await expect(resolveInWorkspace(dir, 'not/created/yet.md')).resolves.toBe(
      join(dir, 'not', 'created', 'yet.md'),
    )
  })
})

/** The same policy has to hold for both sandboxes; the bug was duplicated in both. */
const sandboxes: [string, (dir: string, agentId: string) => Promise<{
  sandbox: Sandbox; handle: AgentHandle; hostDir: string
}>][] = [
  ['LocalSandbox', async (dir, agentId) => {
    const sandbox = new LocalSandbox(dir)
    const handle = await sandbox.provision(agentId, {})
    return { sandbox, handle, hostDir: handle.workspacePath }
  }],
  ['DockerSandbox', (dir, agentId) => dockerFixture(dir, agentId)],
]

describe.each(sandboxes)('%s workspace containment', (_name, build) => {
  test('normal nested files still read and write', async () => {
    const dir = await mkdtemp(join(root, 'ok-'))
    const { sandbox, handle } = await build(dir, 'a1')
    await sandbox.writeFile(handle, 'notes/deep/plan.md', 'plan')
    expect(await sandbox.readFile(handle, 'notes/deep/plan.md')).toBe('plan')
    expect((await sandbox.listFiles(handle)).map((f) => f.path)).toContain('notes/deep/plan.md')
  })

  test('a missing file still reads as null', async () => {
    const dir = await mkdtemp(join(root, 'null-'))
    const { sandbox, handle } = await build(dir, 'a1')
    expect(await sandbox.readFile(handle, 'nothing.md')).toBeNull()
  })

  test.skipIf(!fileLinksAvailable)('a linked SUBMISSION.md cannot read the sibling fixture', async () => {
    const dir = await mkdtemp(join(root, 'readlink-'))
    const { sandbox, handle, hostDir } = await build(dir, 'a1')
    await symlink(outsideFile, join(hostDir, 'SUBMISSION.md'), 'file')
    await expect(sandbox.readFile(handle, 'SUBMISSION.md')).rejects.toBeInstanceOf(WorkspaceEscapeError)
  })

  test.skipIf(!fileLinksAvailable)('a linked final component cannot overwrite the sibling fixture', async () => {
    const dir = await mkdtemp(join(root, 'writelink-'))
    const { sandbox, handle, hostDir } = await build(dir, 'a1')
    await symlink(outsideFile, join(hostDir, 'SUBMISSION.md'), 'file')
    await expect(sandbox.writeFile(handle, 'SUBMISSION.md', 'overwritten')).rejects.toBeInstanceOf(
      WorkspaceEscapeError,
    )
    expect(await readFile(outsideFile, 'utf8')).toBe(OUTSIDE_TEXT)
  })

  test('a linked ancestor directory cannot expose or overwrite the sibling fixture', async () => {
    const dir = await mkdtemp(join(root, 'ancestor-'))
    const { sandbox, handle, hostDir } = await build(dir, 'a1')
    await linkDir(outsideDir, join(hostDir, 'evidence'))
    await expect(sandbox.readFile(handle, `evidence/${OUTSIDE_NAME}`)).rejects.toBeInstanceOf(
      WorkspaceEscapeError,
    )
    await expect(sandbox.writeFile(handle, `evidence/${OUTSIDE_NAME}`, 'overwritten')).rejects.toBeInstanceOf(
      WorkspaceEscapeError,
    )
    expect(await readFile(outsideFile, 'utf8')).toBe(OUTSIDE_TEXT)
  })

  test('the workspace directory itself cannot be swapped for a link', async () => {
    const dir = await mkdtemp(join(root, 'swapped-'))
    const { sandbox, handle, hostDir } = await build(dir, 'a1')
    // What a co-tenant sharing the bind mount can do to a sibling's workspace.
    await rm(hostDir, { recursive: true, force: true })
    await linkDir(outsideDir, hostDir)
    await expect(sandbox.readFile(handle, OUTSIDE_NAME)).rejects.toBeInstanceOf(WorkspaceEscapeError)
    await expect(sandbox.writeFile(handle, OUTSIDE_NAME, 'overwritten')).rejects.toBeInstanceOf(
      WorkspaceEscapeError,
    )
    expect(await readFile(outsideFile, 'utf8')).toBe(OUTSIDE_TEXT)
  })

  test('reset removes a linked directory without deleting what it points at', async () => {
    const dir = await mkdtemp(join(root, 'reset-'))
    const { sandbox, handle, hostDir } = await build(dir, 'a1')
    await linkDir(outsideDir, join(hostDir, 'evidence'))
    // Repairing the workspace, not failing the round: one agent planting a link must not
    // be able to abort everyone's round.
    await sandbox.reset(handle, {})
    expect(await readFile(outsideFile, 'utf8')).toBe(OUTSIDE_TEXT)
    await sandbox.writeFile(handle, 'evidence/mine.md', 'mine')
    expect(await sandbox.readFile(handle, 'evidence/mine.md')).toBe('mine')
  })

  test('listFiles does not walk out through a linked directory', async () => {
    const dir = await mkdtemp(join(root, 'list-'))
    const { sandbox, handle, hostDir } = await build(dir, 'a1')
    await linkDir(outsideDir, join(hostDir, 'evidence'))
    await sandbox.writeFile(handle, 'own.md', 'mine')
    const listed = (await sandbox.listFiles(handle)).map((f) => f.path)
    expect(listed).toContain('own.md')
    expect(listed.some((p) => p.includes(OUTSIDE_NAME))).toBe(false)
  })

  test.skipIf(!fileLinksAvailable)('capture cannot expose the sibling fixture through a link', async () => {
    const dir = await mkdtemp(join(root, 'capture-'))
    const { sandbox, handle, hostDir } = await build(dir, 'a1')
    await symlink(outsideFile, join(hostDir, 'SUBMISSION.md'), 'file')
    // The driver already treats a capture that throws as a missing capture, so the
    // round survives; what matters here is that no host content reaches the judge.
    await expect(captureSubmission(sandbox, handle, { executionStopped: true })).rejects.toBeInstanceOf(
      WorkspaceEscapeError,
    )
  })

  test.skipIf(!fileLinksAvailable)('swapping a captured file for a link reads as tampering, not a crash', async () => {
    const dir = await mkdtemp(join(root, 'verify-'))
    const { sandbox, handle, hostDir } = await build(dir, 'a1')
    await sandbox.writeFile(handle, 'SUBMISSION.md', 'my answer')
    const capture = await captureSubmission(sandbox, handle, { executionStopped: true })
    expect(capture.sha256).not.toBeNull()

    await rm(join(hostDir, 'SUBMISSION.md'), { force: true })
    await symlink(outsideFile, join(hostDir, 'SUBMISSION.md'), 'file')
    const verdict = await verifyCapture(sandbox, handle, capture, { executionStopped: true })
    expect(verdict.tampered).toBe(true)
    expect(verdict.detail).toContain('modified')
  })

  test('an arbitrary read failure is not reported as tampering', async () => {
    const dir = await mkdtemp(join(root, 'ioerror-'))
    const { sandbox, handle } = await build(dir, 'a1')
    await sandbox.writeFile(handle, 'SUBMISSION.md', 'my answer')
    const capture = await captureSubmission(sandbox, handle, { executionStopped: true })

    // Only a refused path means "no longer the file we hashed". A disk error is not
    // evidence that anybody interfered, and must not be recorded as if it were.
    const io = Object.assign(new Error('simulated disk failure'), { code: 'EIO' })
    const broken: Sandbox = { ...sandbox, readFile: () => Promise.reject(io) }
    await expect(verifyCapture(broken, handle, capture, { executionStopped: true })).rejects.toBe(io)
  })
})
