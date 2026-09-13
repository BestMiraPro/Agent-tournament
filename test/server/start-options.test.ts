import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { defaultAuthFile, resolveStartOptions } from '../../src/server/start-options.js'

const root = join('C:', 'app')
const home = join('C:', 'Users', 'someone')
const opencodeAuth = join(home, '.local', 'share', 'opencode', 'auth.json')

const resolve = (argv: string[], opts: { env?: NodeJS.ProcessEnv; files?: string[] } = {}) =>
  resolveStartOptions({
    argv,
    env: opts.env ?? {},
    projectRoot: root,
    home,
    exists: (path) => (opts.files ?? []).includes(path),
  })

describe('resolveStartOptions', () => {
  test('a bare start needs no flags at all', () => {
    const o = resolve([], { files: [opencodeAuth] })
    expect(o).toEqual({
      port: 4300,
      population: 8,
      // Persistent, so runs survive closing the app.
      dbPath: join(root, 'runs', 'dashboard.db'),
      workspaceRoot: join(root, 'runs', 'workspaces'),
      authFile: opencodeAuth,
      serverUrl: null,
      uiDir: join(root, 'dist'),
      open: true,
    })
  })

  test('every flag overrides its default', () => {
    const o = resolve([
      '--port', '5000', '--db', ':memory:', '--population', '3',
      '--workspace-root', '/elsewhere', '--auth-file', '/creds.json',
      '--server-url', 'http://127.0.0.1:4096', '--no-open',
    ], { files: [opencodeAuth] })
    expect(o).toMatchObject({
      port: 5000, dbPath: ':memory:', population: 3, workspaceRoot: '/elsewhere',
      authFile: '/creds.json', serverUrl: 'http://127.0.0.1:4096', open: false,
    })
  })

  test('no credentials on disk means no auth file, not a path to nothing', () => {
    expect(resolve([]).authFile).toBeNull()
  })

  test.each([['0'], ['70000'], ['abc'], ['4300.5']])('rejects port %j', (port) => {
    expect(() => resolve(['--port', port])).toThrow(/--port/)
  })

  test('rejects a population below one', () => {
    expect(() => resolve(['--population', '0'])).toThrow(/--population/)
  })

  test('rejects an unknown flag instead of silently ignoring a typo', () => {
    expect(() => resolve(['--datbase', 'x.db'])).toThrow()
  })
})

describe('defaultAuthFile', () => {
  test('follows XDG_DATA_HOME when it is set', () => {
    const custom = join('D:', 'data')
    const path = join(custom, 'opencode', 'auth.json')
    expect(defaultAuthFile({ XDG_DATA_HOME: custom }, home, (p) => p === path)).toBe(path)
  })

  test('an empty XDG_DATA_HOME falls back to ~/.local/share', () => {
    expect(defaultAuthFile({ XDG_DATA_HOME: '' }, home, (p) => p === opencodeAuth)).toBe(opencodeAuth)
  })
})
