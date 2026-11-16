import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { bridgeCredentials, opencode2Candidates, toV1Auth } from '../../../src/runtime/opencode/credential-bridge.js'
import { PINNED_OPENCODE_VERSION, pinnedOpencodeCommand } from '../../../src/runtime/opencode/pinned.js'

const exported = [
  { id: 'cred_1', integrationID: 'wandb', label: 'CoreWeave', active: true, value: { type: 'key', key: 'fake-wandb-key' } },
  { id: 'cred_2', integrationID: 'wandb', label: 'Old key', active: false, value: { type: 'key', key: 'fake-old-key' } },
  { id: 'cred_3', integrationID: 'openai', label: 'ChatGPT', active: true, value: { type: 'oauth', refresh: 'fake-refresh' } },
  { id: 'cred_4', integrationID: '../escape', label: 'Bad', active: true, value: { type: 'key', key: 'fake' } },
]

describe('toV1Auth', () => {
  test('carries over active API keys in the 1.x auth.json shape', () => {
    const { auth, skipped } = toV1Auth(exported)
    expect(auth).toEqual({ wandb: { type: 'api', key: 'fake-wandb-key' } })
    // OAuth logins are named, never copied; ids that are not plain names are refused.
    expect(skipped).toEqual(['openai (not an API key)', 'an entry without a usable integration id'])
  })

  test('a non-list export carries nothing over', () => {
    expect(toV1Auth({ wandb: 'x' })).toEqual({ auth: {}, skipped: ['export was not a list'] })
  })
})

describe('bridgeCredentials', () => {
  test('writes an owner-only auth.json in the private data folder', async () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'arena-bridge-'))
    const result = await bridgeCredentials({ dataHome, candidates: ['opencode'], exportFn: async () => JSON.stringify(exported) })
    expect(result?.authFile).toBe(join(dataHome, 'opencode', 'auth.json'))
    expect(result?.integrations).toEqual(['wandb'])
    expect(JSON.parse(readFileSync(result!.authFile, 'utf8'))).toEqual({ wandb: { type: 'api', key: 'fake-wandb-key' } })
    if (process.platform !== 'win32') expect(statSync(result!.authFile).mode & 0o777).toBe(0o600)
  })

  test('returns null when there is no API key to carry over', async () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'arena-bridge-'))
    const only = JSON.stringify([exported[2]])
    expect(await bridgeCredentials({ dataHome, candidates: ['opencode'], exportFn: async () => only })).toBeNull()
  })

  test('skips a candidate whose export is not JSON and tries the next', async () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'arena-bridge-'))
    const exportFn = async (command: string) => (command === 'first' ? 'Error: not signed in' : JSON.stringify(exported))
    const result = await bridgeCredentials({ dataHome, candidates: ['first', 'second'], exportFn })
    expect(result?.integrations).toEqual(['wandb'])
  })
})

describe('pinned OpenCode', () => {
  test('the pin matches the Docker agent image', () => {
    const dockerfile = readFileSync(new URL('../../../docker/Dockerfile.agent', import.meta.url), 'utf8')
    expect(dockerfile).toContain(`opencode-ai@${PINNED_OPENCODE_VERSION}`)
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
    expect(pkg.dependencies['opencode-ai']).toBe(PINNED_OPENCODE_VERSION)
  })

  test('prefers the CLI in node_modules, else opencode on PATH', () => {
    expect(pinnedOpencodeCommand('/repo', (p) => p === '/repo/node_modules/.bin/opencode', 'darwin')).toBe('/repo/node_modules/.bin/opencode')
    expect(pinnedOpencodeCommand('/repo', () => false, 'linux')).toBe('opencode')
    expect(pinnedOpencodeCommand('C:\\repo', () => true, 'win32')).toMatch(/^".*opencode\.cmd"$/)
  })

  test('looks for an OpenCode 2 CLI in the override, PATH, then the macOS app', () => {
    expect(opencode2Candidates({ ARENA_OPENCODE2_BIN: '/x/opencode' }, 'darwin')).toEqual([
      '/x/opencode',
      'opencode',
      '/Applications/OpenCode.app/Contents/Resources/opencode-cli',
    ])
    expect(opencode2Candidates({}, 'linux')).toEqual(['opencode'])
  })
})
