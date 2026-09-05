import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { clearModelsCache, listModels } from '../../web/src/api.js'

const ok = (models: string[]) =>
  new Response(JSON.stringify({ models }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => clearModelsCache())
afterEach(() => {
  vi.unstubAllGlobals()
  clearModelsCache()
})

describe('listModels caching', () => {
  test('fetches once and serves the cache afterwards', async () => {
    const fetchMock = vi.fn(async () => ok(['a/1', 'b/2']))
    vi.stubGlobal('fetch', fetchMock)

    expect(await listModels()).toEqual(['a/1', 'b/2'])
    expect(await listModels()).toEqual(['a/1', 'b/2'])
    expect(await listModels()).toEqual(['a/1', 'b/2'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('concurrent callers share a single request', async () => {
    // Two components mount at once; that should be one request, not two.
    let resolve!: (r: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>((r) => { resolve = r }))
    vi.stubGlobal('fetch', fetchMock)

    const a = listModels()
    const b = listModels()
    resolve(ok(['a/1']))

    expect(await a).toEqual(['a/1'])
    expect(await b).toEqual(['a/1'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('does not cache a failure', async () => {
    // A models endpoint that was briefly down must not leave the pickers empty
    // for the rest of the session.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(ok(['a/1']))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listModels()).rejects.toThrow()
    expect(await listModels()).toEqual(['a/1'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('clearModelsCache forces a refetch', async () => {
    const fetchMock = vi.fn(async () => ok(['a/1']))
    vi.stubGlobal('fetch', fetchMock)

    await listModels()
    clearModelsCache()
    await listModels()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
