import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { assertStoreOutside, ConnectorStore, newConnectorRecord } from '../../src/connectors/store.js'

const dirs: string[] = []
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-connectors-'))
  dirs.push(dir)
  return join(dir, 'connectors')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SECRET = 'xoxp-SYNTHETIC-SECRET-0001'

describe('connector store', () => {
  test('keeps credentials in a separate owner-only file, never in the connector list', () => {
    const store = new ConnectorStore(fresh(), { now: () => 1000 })
    store.create(newConnectorRecord({ id: 'slack', title: 'Slack', kind: 'slack', transport: { type: 'slack' }, auth: { type: 'token', source: 'manual' } }, 1000), { token: SECRET })
    const list = readFileSync(join(store.dir, 'connectors.json'), 'utf8')
    expect(list).toContain('"slack"')
    expect(list).not.toContain(SECRET)
    const secrets = readFileSync(join(store.dir, 'secrets.json'), 'utf8')
    expect(secrets).toContain(SECRET)
    if (process.platform !== 'win32') {
      expect(statSync(join(store.dir, 'secrets.json')).mode & 0o777).toBe(0o600)
      expect(statSync(join(store.dir, 'connectors.json')).mode & 0o777).toBe(0o600)
      expect(statSync(store.dir).mode & 0o777).toBe(0o700)
    }
    expect(store.secrets('slack').token).toBe(SECRET)
    expect(store.secretNames('slack')).toEqual(['token'])
  })

  test('creates, updates and removes, taking the secrets with it', () => {
    const store = new ConnectorStore(fresh())
    const rec = newConnectorRecord({ id: 'gh', title: 'GitHub', kind: 'github', transport: { type: 'http', url: 'https://example.invalid/mcp', headers: {}, secretHeaders: [] }, auth: { type: 'token', source: 'manual' } }, 1)
    store.create(rec, { token: 'ghp_SYNTHETIC' })
    expect(() => store.create(rec)).toThrow(/already exists/)
    store.update('gh', (r) => ({ ...r, title: 'GitHub (work)' }))
    expect(store.get('gh')?.title).toBe('GitHub (work)')
    store.setSecrets('gh', (s) => ({ ...s, headers: { 'X-Extra': 'v' } }))
    expect(store.secretNames('gh').sort()).toEqual(['headers', 'token'])
    expect(store.remove('gh')).toBe(true)
    expect(store.get('gh')).toBeNull()
    expect(store.secrets('gh')).toEqual({})
    expect(readFileSync(join(store.dir, 'secrets.json'), 'utf8')).not.toContain('ghp_SYNTHETIC')
  })

  test('refuses reserved or malformed ids and an update that changes the id', () => {
    const store = new ConnectorStore(fresh())
    expect(() => store.create(newConnectorRecord({ id: 'external', title: 'x', kind: 'custom', transport: { type: 'stdio', command: 'x', args: [], env: {}, secretEnv: [] }, auth: { type: 'none' } }, 1))).toThrow(/reserved/)
    store.create(newConnectorRecord({ id: 'ok', title: 'x', kind: 'custom', transport: { type: 'stdio', command: 'x', args: [], env: {}, secretEnv: [] }, auth: { type: 'none' } }, 1))
    expect(() => store.update('ok', (r) => ({ ...r, id: 'other' }))).toThrow(/id/)
  })

  test('refuses a locked connector that permits write tools', () => {
    const store = new ConnectorStore(fresh())
    const rec = newConnectorRecord({ id: 'mail', title: 'Gmail', kind: 'gmail', transport: { type: 'gmail' }, auth: { type: 'oauth-google' } }, 1)
    expect(() => store.create({ ...rec, policy: { disabledTools: [], writeTools: ['send_message'] } })).toThrow(/read-only/)
    store.create(rec)
    expect(() => store.update('mail', (r) => ({ ...r, policy: { disabledTools: [], writeTools: ['send_message'] } }))).toThrow(/read-only/)
  })

  test('a damaged file is refused by path, without repeating its content', () => {
    const store = new ConnectorStore(fresh())
    store.create(newConnectorRecord({ id: 'ok', title: 'x', kind: 'custom', transport: { type: 'stdio', command: 'x', args: [], env: {}, secretEnv: [] }, auth: { type: 'none' } }, 1), { token: SECRET })
    writeFileSync(join(store.dir, 'secrets.json'), `{"broken": "${SECRET}`)
    let message = ''
    try {
      store.secrets('ok')
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('secrets.json')
    expect(message).not.toContain(SECRET)
  })
})

describe('store placement', () => {
  test('refuses a workspace root, context folder or seed folder that overlaps the store', () => {
    const root = mkdtempSync(join(tmpdir(), 'arena-place-'))
    dirs.push(root)
    const store = join(root, 'runs', 'connectors')
    expect(() => assertStoreOutside(store, { workspaceRoot: join(root, 'runs', 'workspaces') })).not.toThrow()
    expect(() => assertStoreOutside(store, { workspaceRoot: join(root, 'runs') })).toThrow(/workspace root/)
    expect(() => assertStoreOutside(store, { contextDir: root })).toThrow(/context folder/)
    expect(() => assertStoreOutside(store, { seedDir: join(store, 'inner') })).toThrow(/seed folder/)
    expect(() => assertStoreOutside(store, { contextDir: null, seedDir: null })).not.toThrow()
  })
})
