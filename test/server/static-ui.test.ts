import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { serveUi } from '../../src/server/static-ui.js'

let base = ''
let ui = ''

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'static-ui-'))
  ui = join(base, 'dist')
  await mkdir(join(ui, 'assets'), { recursive: true })
  await writeFile(join(ui, 'index.html'), '<!doctype html><div id="root"></div>')
  await writeFile(join(ui, 'assets', 'app-abc123.js'), 'console.log("app")')
  await writeFile(join(ui, 'assets', 'app-abc123.css'), 'body{}')
  // Beside the UI directory, where only a traversal could reach it.
  await writeFile(join(base, 'secret.txt'), 'outside the ui directory')
})

afterEach(async () => {
  if (base.startsWith(tmpdir())) await rm(base, { recursive: true, force: true })
})

const appWith = (dir: string) => {
  const app = Fastify()
  // A real API route, registered first exactly as buildApi's are.
  app.get('/api/runs', async () => ({ runs: [] }))
  serveUi(app, dir)
  return app
}

describe('serveUi', () => {
  test('serves the app at the root, revalidated every time', async () => {
    const res = await appWith(ui).inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.body).toContain('id="root"')
  })

  test.each([
    ['/assets/app-abc123.js', /text\/javascript/],
    ['/assets/app-abc123.css', /text\/css/],
  ])('serves %s with its type and a permanent cache', async (url, type) => {
    const res = await appWith(ui).inject({ method: 'GET', url })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(type)
    expect(res.headers['cache-control']).toMatch(/immutable/)
  })

  test('the API still answers, and an unknown API path is a JSON 404 rather than the page', async () => {
    const app = appWith(ui)
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/runs' })).body)).toEqual({ runs: [] })
    const missing = await app.inject({ method: 'GET', url: '/api/no-such-endpoint' })
    expect(missing.statusCode).toBe(404)
    expect(missing.headers['content-type']).toMatch(/json/)
    expect(missing.body).not.toContain('id="root"')
  })

  test('a missing file is a 404, not the page', async () => {
    const res = await appWith(ui).inject({ method: 'GET', url: '/assets/gone-999.js' })
    expect(res.statusCode).toBe(404)
  })

  test('an extensionless path is the app itself', async () => {
    const res = await appWith(ui).inject({ method: 'GET', url: '/runs/some-run' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id="root"')
  })

  test.each([
    ['/..%2fsecret.txt'],
    ['/%2e%2e%2fsecret.txt'],
    ['/assets/..%2f..%2fsecret.txt'],
    ['/%2e%2e/secret.txt'],
  ])('traversal %j never reaches a file outside the UI directory', async (url) => {
    const res = await appWith(ui).inject({ method: 'GET', url })
    expect(res.body).not.toContain('outside the ui directory')
    expect(res.statusCode).not.toBe(200)
  })

  test('a malformed escape is rejected rather than thrown', async () => {
    const res = await appWith(ui).inject({ method: 'GET', url: '/%E0%A4%A' })
    expect(res.statusCode).toBe(400)
  })

  test('an unbuilt UI says how to build it instead of a bare 404', async () => {
    const res = await appWith(join(base, 'never-built')).inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(503)
    expect(res.body).toContain('npm start')
  })
})
