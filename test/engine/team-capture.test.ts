import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { captureTeamOutput, looksBinary, teamContributions } from '../../src/engine/team-capture.js'
import { LocalSandbox } from '../../src/runtime/local-sandbox.js'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
const quota = { maxBytes: 1_000_000 }

describe('captureTeamOutput', () => {
  test('hashes every output file, stores text, lists binary, and seals only a stopped team', async () => {
    const sb = new MockSandbox()
    const h = (await sb.provisionTeam('t', ['a'], {})).handles.get('a')!
    await sb.writeFile(h, 'output/README.md', '# Built')
    await sb.writeFile(h, 'output/plot.png', 'PNG\u0000�data')
    await sb.writeFile(h, 'agents/agent-01/scratch.txt', 'not judged')
    await sb.writeFile(h, 'CHANNEL.md', '# Team channel\n')
    const c = await captureTeamOutput(sb, h, { executionStopped: true, quota })
    expect(c).toMatchObject({ status: 'ok', sealed: true, hashesComplete: true, fileCount: 2, readmeMd: '# Built' })
    expect(c.files.map((f) => [f.path, f.binary, f.stored])).toEqual([['output/README.md', false, true], ['output/plot.png', true, false]])
    expect([...c.contents.keys()]).toEqual(['output/README.md'])
    expect(c.channelSha256).toMatch(/^[0-9a-f]{64}$/)
    const again = await captureTeamOutput(sb, h, { executionStopped: false, quota })
    expect(again.digest).toBe(c.digest)
    expect(again.sealed).toBe(false)
    await sb.writeFile(h, 'output/README.md', '# Built, then changed')
    expect((await captureTeamOutput(sb, h, { executionStopped: true, quota })).digest).not.toBe(c.digest)
  })

  test('an empty folder has nothing to judge; a team over its cap is an error naming it', async () => {
    const sb = new MockSandbox()
    const h = (await sb.provisionTeam('t', ['a'], {})).handles.get('a')!
    await sb.writeFile(h, 'notes.md', 'x')
    expect(await captureTeamOutput(sb, h, { executionStopped: true, quota })).toMatchObject({ status: 'no_submission', fileCount: 0 })
    await sb.writeFile(h, 'output/a.md', 'a')
    await sb.writeFile(h, 'output/b.md', 'b')
    const over = await captureTeamOutput(sb, h, { executionStopped: true, quota: { maxBytes: 2 * 4096 } })
    expect(over.status).toBe('error')
    expect(over.errorText).toBe('team workspace uses 12 KiB of disk (3 files, each counted as at least 4 KiB), limit is 8 KiB')
  })

  test('a channel file turned into a link is left out rather than failing the round', async (ctx) => {
    const root = await mkdtemp(join(tmpdir(), 'arena-team-capture-'))
    dirs.push(root)
    const outside = join(root, 'outside.md')
    await writeFile(outside, 'secret')
    const sb = new LocalSandbox(join(root, 'ws'))
    const h = (await sb.provisionTeam('t', ['a'], {})).handles.get('a')!
    await sb.writeFile(h, 'output/README.md', '# Built')
    try {
      await symlink(outside, join(h.workspacePath, 'CHANNEL.md'))
    } catch (e) {
      // Windows without symlink privilege (see workspace-links.test.ts): nothing to test here.
      if ((e as NodeJS.ErrnoException).code === 'EPERM') ctx.skip()
      throw e
    }
    const c = await captureTeamOutput(sb, h, { executionStopped: true, quota })
    expect(c.status).toBe('ok')
    expect(c.channelMd).toBeNull()
    expect(c.channelSha256).toBeNull()
  })

  test('text and binary tell apart by what decoding left behind', () => {
    expect(looksBinary('plain text\n')).toBe(false)
    expect(looksBinary('a\u0000b')).toBe(true)
    expect(looksBinary('bad � byte')).toBe(true)
  })
})

describe('teamContributions', () => {
  test('counts only what each member\'s own activity shows, inside the workspace', () => {
    const rec = (agentId: string, kind: 'tool' | 'file', summary: string, outcome: 'completed' | 'failed' = 'completed') => ({
      schemaVersion: 1 as const, id: 'E1', runId: 'r', roundId: 'x', agentId, sessionId: null, observedAt: 1, source: 'provider_stream' as const, kind, summary, outcome,
    })
    const out = teamContributions(
      [{ agentId: 'A', label: 'agent-01' }, { agentId: 'B', label: 'agent-02' }],
      [
        rec('A', 'tool', 'write: /work/output/model.py'),
        rec('A', 'tool', 'edit: /work/output/README.md'),
        rec('A', 'tool', 'bash: python output/model.py'),
        rec('A', 'tool', 'write: /etc/passwd'),
        rec('A', 'tool', 'write: /work/output/failed.py', 'failed'),
        rec('B', 'file', 'edited output/README.md'),
        rec('B', 'tool', 'write: ../escape.md'),
      ],
      [{ seq: 1, author: 'agent-02', target: null, postedAt: 't', body: 'hi', key: 'k', agentId: 'B' }],
      '/work',
    )
    expect(out.A).toEqual({ label: 'agent-01', files: ['output/README.md', 'output/model.py'], posts: 0, toolCalls: 5 })
    expect(out.B).toEqual({ label: 'agent-02', files: ['output/README.md'], posts: 1, toolCalls: 1 })
  })
})
