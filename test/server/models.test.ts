import { beforeEach, describe, expect, test, vi } from 'vitest'
import { buildApi, _resetModelsCacheForTests } from '../../src/server/api.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'

// Fake starter: canned client with a canned providers response (no daemon).
const cannedClient = (models: Record<string, Record<string, unknown>>, stop = vi.fn(async () => {})) => ({
  providers: async () => ({ providers: [{ id: 'acme', models }] }),
  stop,
})

const setup = (startModelsServer: () => Promise<never>) => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const app = buildApi({
    repos,
    manager: {
      isBusy: () => false,
      lastError: () => null,
      startRound: () => {},
    } as never,
    createRun: (name: string) => {
      const r = repos.runs.create({ name, config: DEFAULT_CONFIG, seedDir: null })
      return r.id
    },
    startModelsServer: startModelsServer as never,
  })
  return { app }
}

beforeEach(() => {
  _resetModelsCacheForTests()
})

describe('GET /api/models', () => {
  test('passes discovery order through untouched', async () => {
    const stop = vi.fn(async () => {})
    const { app } = setup(async () => ({
      baseUrl: 'http://127.0.0.1:9',
      client: cannedClient({ 'z-model': {}, 'a-model': {} }, stop),
      stop,
    }) as never)
    const res = await app.inject({ method: 'GET', url: '/api/models' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ models: ['acme/z-model', 'acme/a-model'] })
  })

  test('starter throw degrades to 502 with the message', async () => {
    const { app } = setup(async () => {
      throw new Error('opencode not on PATH')
    })
    const res = await app.inject({ method: 'GET', url: '/api/models' })
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body).error).toMatch(/not on PATH/)
  })

  test('discovery throw degrades to 502', async () => {
    const stop = vi.fn(async () => {})
    const { app } = setup(async () => ({
      baseUrl: 'http://127.0.0.1:9',
      client: { providers: async () => { throw new Error('providers blew up') } },
      stop,
    }) as never)
    const res = await app.inject({ method: 'GET', url: '/api/models' })
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body).error).toMatch(/blew up/)
  })

  test('two rapid calls start only once (success cached)', async () => {
    const start = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:9',
      client: cannedClient({ m: {} }),
      stop: async () => {},
    }) as never)
    const { app } = setup(start)
    expect((await app.inject({ method: 'GET', url: '/api/models' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/models' })).statusCode).toBe(200)
    expect(start).toHaveBeenCalledTimes(1)
  })

  test('failures are never cached (two failing calls start twice)', async () => {
    const start = vi.fn(async () => {
      throw new Error('no binary')
    })
    const { app } = setup(start)
    expect((await app.inject({ method: 'GET', url: '/api/models' })).statusCode).toBe(502)
    expect((await app.inject({ method: 'GET', url: '/api/models' })).statusCode).toBe(502)
    expect(start).toHaveBeenCalledTimes(2)
  })

  test('discovery failures are never cached (two failing calls start twice)', async () => {
    const start = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:9',
      client: { providers: async () => { throw new Error('providers blew up') } },
      stop: async () => {},
    }) as never)
    const { app } = setup(start)
    expect((await app.inject({ method: 'GET', url: '/api/models' })).statusCode).toBe(502)
    expect((await app.inject({ method: 'GET', url: '/api/models' })).statusCode).toBe(502)
    expect(start).toHaveBeenCalledTimes(2)
  })

  test('stop runs after a successful discovery (finally)', async () => {
    const stop = vi.fn(async () => {})
    const { app } = setup(async () => ({
      baseUrl: 'http://127.0.0.1:9',
      client: cannedClient({ m: {} }, stop),
      stop,
    }) as never)
    expect((await app.inject({ method: 'GET', url: '/api/models' })).statusCode).toBe(200)
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
