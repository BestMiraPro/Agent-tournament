import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/core/types.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { buildApi, OPERATOR_POST_MAX_CHARS } from '../../src/server/api.js'
import { RunRegistry } from '../../src/server/runs.js'
import { appendUnderLock } from '../../src/runtime/locked-append.js'

describe('POST /api/runs/:runId/channel', () => {
  const setup = (posts: string[], running: boolean) => {
    const repos = makeRepos(openDb(':memory:'))
    const run = repos.runs.create({ name: 'team', config: DEFAULT_CONFIG, seedDir: null })
    const manager = {
      isBusy: () => running,
      lastError: () => null,
      startRound: () => {},
      postToTeam: async (runId: string, text: string) => {
        if (!running) return false
        posts.push(`${runId}:${text}`)
        return true
      },
    } as never
    const api = buildApi({ repos, manager, createRun: (name: string) => repos.runs.create({ name, config: DEFAULT_CONFIG, seedDir: null }).id, registry: new RunRegistry() })
    return { api, run }
  }

  test('a running team gets the message: 202', async () => {
    const posts: string[] = []
    const { api, run } = setup(posts, true)
    const res = await api.inject({ method: 'POST', url: `/api/runs/${run.id}/channel`, payload: { body: '  Focus on the benchmarks.  ' } })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ posted: true })
    expect(posts).toEqual([`${run.id}:Focus on the benchmarks.`])
  })

  test('no running collaboration round: 409, nothing posted', async () => {
    const posts: string[] = []
    const { api, run } = setup(posts, false)
    const res = await api.inject({ method: 'POST', url: `/api/runs/${run.id}/channel`, payload: { body: 'hello' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/no collaboration round is running/)
    expect(posts).toEqual([])
  })

  test('an empty or oversized message: 400; an unknown run: 404', async () => {
    const posts: string[] = []
    const { api, run } = setup(posts, true)
    for (const body of ['   ', 'x'.repeat(OPERATOR_POST_MAX_CHARS + 1)]) {
      expect((await api.inject({ method: 'POST', url: `/api/runs/${run.id}/channel`, payload: { body } })).statusCode).toBe(400)
    }
    expect((await api.inject({ method: 'POST', url: '/api/runs/nope/channel', payload: { body: 'x' } })).statusCode).toBe(404)
    expect(posts).toEqual([])
  })
})

describe('appendUnderLock', () => {
  const dirs: string[] = []
  afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
  const file = async () => {
    const d = await mkdtemp(join(tmpdir(), 'locked-append-'))
    dirs.push(d)
    const f = join(d, 'CHANNEL.md')
    await writeFile(f, '# Team channel\n')
    return f
  }

  test('concurrent appends all land, and the lock is released', async () => {
    const f = await file()
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendUnderLock(f, `\n### a${i} · t\nbody ${i}\n`)))
    const text = await readFile(f, 'utf8')
    for (let i = 0; i < 20; i++) expect(text).toContain(`body ${i}`)
    await expect(mkdir(`${f}.lock`)).resolves.toBeUndefined()
  })

  test('waits for a lock someone holds, and clears one left behind', async () => {
    const f = await file()
    await mkdir(`${f}.lock`)
    let done = false
    const pending = appendUnderLock(f, 'after the holder\n').then(() => { done = true })
    await new Promise((r) => setTimeout(r, 80))
    expect(done).toBe(false)
    await rm(`${f}.lock`, { recursive: true })
    await pending
    expect(await readFile(f, 'utf8')).toContain('after the holder')

    await mkdir(`${f}.lock`)
    const old = new Date(Date.now() - 60_000)
    await utimes(`${f}.lock`, old, old)
    await appendUnderLock(f, 'past a stale lock\n')
    expect(await readFile(f, 'utf8')).toContain('past a stale lock')
  })
})
