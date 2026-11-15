import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DockerSandbox } from '../../src/runtime/docker/sandbox.js'
import { LocalSandbox } from '../../src/runtime/local-sandbox.js'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'

const dirs: string[] = []
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'arena-team-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('MockSandbox team workspace', () => {
  test('every member shares one workspace, seeded once and kept across rounds', async () => {
    const sb = new MockSandbox({ seedFiles: { 'data/in.csv': 'a,b' } })
    const first = await sb.provisionTeam('run1', ['a1', 'a2'], { seedDir: '/seed' })
    expect(first.created).toBe(true)
    const a1 = first.handles.get('a1')!
    const a2 = first.handles.get('a2')!
    expect(a1.workspacePath).toBe(a2.workspacePath)
    await sb.writeFile(a1, 'output/x.md', 'from a1')
    expect(await sb.readFile(a2, 'output/x.md')).toBe('from a1')
    await sb.writeFile(a2, 'data/in.csv', 'edited')

    const second = await sb.provisionTeam('run1', ['a1', 'a2', 'a3'], { seedDir: '/seed' })
    expect(second.created).toBe(false)
    const a3 = second.handles.get('a3')!
    expect(await sb.readFile(a3, 'output/x.md')).toBe('from a1')
    // The seed never overwrites the team's own edits on a later round.
    expect(await sb.readFile(a3, 'data/in.csv')).toBe('edited')
  })

  test('different teams never share files', async () => {
    const sb = new MockSandbox()
    const a = (await sb.provisionTeam('run1', ['a1'], {})).handles.get('a1')!
    const b = (await sb.provisionTeam('run2', ['b1'], {})).handles.get('b1')!
    await sb.writeFile(a, 'output/x.md', 'x')
    expect(await sb.readFile(b, 'output/x.md')).toBeNull()
  })
})

describe('LocalSandbox team workspace', () => {
  test('one directory under the root, seeded only when created', async () => {
    const root = await tmp()
    const seed = await tmp()
    await writeFile(join(seed, 'brief.md'), 'seeded')
    const sb = new LocalSandbox(root)
    const first = await sb.provisionTeam('run1', ['a1', 'a2'], { seedDir: seed })
    expect(first.created).toBe(true)
    const dir = join(root, 'team-run1')
    expect(first.handles.get('a1')!.workspacePath).toBe(dir)
    expect(first.handles.get('a2')!.workspacePath).toBe(dir)
    await sb.writeFile(first.handles.get('a1')!, 'brief.md', 'edited by the team')
    await sb.writeFile(first.handles.get('a2')!, 'output/README.md', '# out')

    const second = await sb.provisionTeam('run1', ['a1', 'a2'], { seedDir: seed })
    expect(second.created).toBe(false)
    expect(await readFile(join(dir, 'brief.md'), 'utf8')).toBe('edited by the team')
    expect((await sb.listFiles(second.handles.get('a1')!)).map((f) => f.path).sort()).toEqual(['brief.md', 'output/README.md'])
  })

  test('refuses a team id that is not a plain name', async () => {
    const sb = new LocalSandbox(await tmp())
    await expect(sb.provisionTeam('../escape', ['a1'], {})).rejects.toThrow(/team id/)
  })
})

describe('DockerSandbox team placement', () => {
  const make = async (agentIds: string[]) => {
    const root = await tmp()
    const started: { shardIndex: number; hostDir: string; members: number }[] = []
    const sb = new DockerSandbox({
      runId: 't', root, maxContainers: 1, image: 'x', memory: '1g', cpus: 1, authFile: null,
      isolation: 'protected', team: true,
      startContainer: async (shardIndex, hostDir, members) => {
        started.push({ shardIndex, hostDir, members })
        return { name: `arena-t-${shardIndex}`, baseUrl: 'http://127.0.0.1:40000', shardIndex, containerId: 'cid0' }
      },
      stopContainer: async () => {},
    })
    await sb.planFor(agentIds)
    return { sb, root, started }
  }

  test('the whole team goes in one container, whatever maxContainers says, with protected isolation', async () => {
    const { sb } = await make(['a1', 'a2', 'a3'])
    expect(sb.placement()).toEqual([{ shardIndex: 0, agentIds: ['a1', 'a2', 'a3'], occupancy: 'shared' }])
  })

  test('the team workspace is the container /work, started once and sized for the team', async () => {
    const { sb, root, started } = await make(['a1', 'a2', 'a3'])
    const team = await sb.provisionTeam('run1', ['a1', 'a2', 'a3'], {})
    expect(team.created).toBe(true)
    expect(started).toEqual([{ shardIndex: 0, hostDir: join(root, 'team-run1'), members: 3 }])
    for (const id of ['a1', 'a2', 'a3']) {
      const h = team.handles.get(id)!
      expect(h.workspacePath).toBe('/work')
      expect(h.baseUrl).toBe('http://127.0.0.1:40000')
      expect(h.runtimeId).toBe('cid0')
    }
    await sb.writeFile(team.handles.get('a1')!, 'output/README.md', 'hi')
    expect(await readFile(join(root, 'team-run1', 'output', 'README.md'), 'utf8')).toBe('hi')
    expect(await sb.readFile(team.handles.get('a3')!, 'output/README.md')).toBe('hi')
  })

  test('the workspace survives the per-round worker release', async () => {
    const { sb } = await make(['a1', 'a2'])
    const first = await sb.provisionTeam('run1', ['a1', 'a2'], {})
    await sb.writeFile(first.handles.get('a1')!, 'output/x.md', 'kept')
    await sb.releaseRound()
    await sb.planFor(['a1', 'a2'])
    const second = await sb.provisionTeam('run1', ['a1', 'a2'], {})
    expect(second.created).toBe(false)
    expect(await sb.readFile(second.handles.get('a2')!, 'output/x.md')).toBe('kept')
  })
})
