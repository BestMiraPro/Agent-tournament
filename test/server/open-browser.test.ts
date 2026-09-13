import Fastify from 'fastify'
import { describe, expect, test, vi } from 'vitest'
import { browserCommand, openBrowser, probeDashboard } from '../../src/server/open-browser.js'

const url = 'http://127.0.0.1:4300'

describe('browserCommand', () => {
  test.each([
    ['win32', 'rundll32', ['url.dll,FileProtocolHandler', url]],
    ['darwin', 'open', [url]],
    ['linux', 'xdg-open', [url]],
  ] as const)('%s uses its own launcher, with no shell', (platform, file, args) => {
    expect(browserCommand(url, platform)).toEqual({ file, args })
  })

  test.each([
    ['https://example.com'],
    ['http://127.0.0.1:4300/../../etc'],
    ['file:///C:/Windows/System32/calc.exe'],
    ['http://127.0.0.1:4300 & calc'],
  ])('refuses to hand %j to the OS', (bad) => {
    expect(() => browserCommand(bad, 'win32')).toThrow(/non-local/)
  })
})

describe('openBrowser', () => {
  test('a launcher failure is reported, never thrown', () => {
    const failures: string[] = []
    const run = vi.fn((_f: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) => {
      cb(new Error('no display'))
    })
    expect(() => openBrowser(url, (m) => failures.push(m), run, 'linux')).not.toThrow()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/open http:\/\/127\.0\.0\.1:4300 yourself/)
  })

  test('a refused URL never reaches the launcher', () => {
    const run = vi.fn()
    const failures: string[] = []
    openBrowser('https://example.com', (m) => failures.push(m), run as never, 'win32')
    expect(run).not.toHaveBeenCalled()
    expect(failures).toHaveLength(1)
  })
})

describe('probeDashboard', () => {
  const serve = async (handler: () => unknown) => {
    const app = Fastify()
    app.get('/api/runs', async () => handler())
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return { app, url: `http://127.0.0.1:${port}` }
  }

  test('recognises a running dashboard by its run list', async () => {
    const { app, url: base } = await serve(() => ({ runs: [] }))
    try {
      expect(await probeDashboard(base)).toBe(true)
    } finally {
      await app.close()
    }
  })

  test('something else on the port is not mistaken for the app', async () => {
    const { app, url: base } = await serve(() => ({ hello: 'world' }))
    try {
      expect(await probeDashboard(base)).toBe(false)
    } finally {
      await app.close()
    }
  })

  test('nothing listening is simply false', async () => {
    const { app, url: base } = await serve(() => ({ runs: [] }))
    await app.close()
    expect(await probeDashboard(base, 500)).toBe(false)
  })
})
