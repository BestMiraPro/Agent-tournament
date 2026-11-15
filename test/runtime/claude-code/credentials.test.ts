import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  ClaudeTokenStore,
  findClaudeCli,
  hostLoginStatus,
  normalizeClaudeToken,
  resolveClaudeCredentials,
  validClaudeToken,
  type ExecText,
} from '../../../src/runtime/claude-code/credentials.js'
import { SubscriptionLimitGate } from '../../../src/runtime/claude-code/limit-gate.js'

const TOKEN = 'sk-ant-oat01-' + 'A1b2C3d4'.repeat(10)

describe('Claude token store', () => {
  test('stores a pasted token 0600 in a 0700 folder and reads it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arena-secrets-'))
    const store = new ClaudeTokenStore(join(dir, 'secrets', 'claude-subscription.json'))
    expect(await store.read()).toBeNull()
    // A terminal wraps long tokens; the paste comes back with line breaks and indentation.
    await store.set(`  ${TOKEN.slice(0, 30)}\n    ${TOKEN.slice(30)}\n`)
    expect(await store.read()).toBe(TOKEN)
    if (process.platform !== 'win32') {
      expect(statSync(store.file).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, 'secrets')).mode & 0o777).toBe(0o700)
    }
    expect(await store.clear()).toBe(true)
    expect(await store.read()).toBeNull()
  })

  test('refuses something that is not a token without echoing it', async () => {
    const store = new ClaudeTokenStore(join(mkdtempSync(join(tmpdir(), 'arena-secrets-')), 'c.json'))
    await expect(store.set('short')).rejects.toThrow(/does not look like/)
    await expect(store.set('has;semicolons;that;are;not;token;chars')).rejects.not.toThrow(/semicolons/)
    expect(validClaudeToken(normalizeClaudeToken(` ${TOKEN} `))).toBe(true)
  })

  test('a corrupted file reads as no token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arena-secrets-'))
    const store = new ClaudeTokenStore(join(dir, 'c.json'))
    await store.set(TOKEN)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(store.file, '{not json')
    expect(await store.read()).toBeNull()
    expect(readFileSync(store.file, 'utf8')).toBe('{not json')
  })
})

describe('host login and CLI discovery', () => {
  test('finds the CLI from CLAUDE_CLI_PATH, PATH, then the installer locations', () => {
    const files = new Set(['/opt/x/claude', '/usr/bin/claude', '/home/o/.local/bin/claude'])
    const isFile = (p: string) => files.has(p)
    expect(findClaudeCli({ CLAUDE_CLI_PATH: '/opt/x/claude' }, '/home/o', isFile, 'linux')).toBe('/opt/x/claude')
    expect(findClaudeCli({ CLAUDE_CLI_PATH: '/missing' }, '/home/o', isFile, 'linux')).toBeNull()
    expect(findClaudeCli({ PATH: '/nope:/usr/bin' }, '/home/o', isFile, 'linux')).toBe('/usr/bin/claude')
    expect(findClaudeCli({ PATH: '/nope' }, '/home/o', isFile, 'linux')).toBe('/home/o/.local/bin/claude')
    expect(findClaudeCli({ PATH: '' }, '/elsewhere', () => false, 'linux')).toBeNull()
  })

  test('reads only whether the host is signed in to a subscription, never account details', async () => {
    const calls: { args: string[]; env: Record<string, string> }[] = []
    const exec: ExecText = async (_f, args, opts) => {
      calls.push({ args, env: opts.env })
      return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'owner@example.com', orgName: 'Org' }) }
    }
    const login = await hostLoginStatus('/bin/claude', exec)
    expect(login).toEqual({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })
    expect(JSON.stringify(login)).not.toContain('example.com')
    expect(calls[0]!.args).toEqual(['auth', 'status', '--json'])
    expect(Object.keys(calls[0]!.env).some((k) => /^(ANTHROPIC|CLAUDE)/.test(k))).toBe(false)
    const out = await hostLoginStatus('/bin/claude', async () => ({ code: 1, stdout: '{"loggedIn":false,"authMethod":"none"}' }))
    expect(out.loggedIn).toBe(false)
  })

  test('credentials: a stored token wins, then the host login; containers need a token', async () => {
    const signedIn = async () => ({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' })
    const apiKeyLogin = async () => ({ loggedIn: true, authMethod: 'console', subscriptionType: null })
    expect(await resolveClaudeCredentials({ store: { read: async () => TOKEN }, hostLogin: signedIn, allowHost: true })).toEqual({ mode: 'token', token: TOKEN })
    expect(await resolveClaudeCredentials({ store: { read: async () => null }, hostLogin: signedIn, allowHost: true })).toEqual({ mode: 'host' })
    await expect(resolveClaudeCredentials({ store: { read: async () => null }, hostLogin: apiKeyLogin, allowHost: true })).rejects.toThrow(/not signed in/)
    await expect(resolveClaudeCredentials({ store: { read: async () => null }, hostLogin: signedIn, allowHost: false })).rejects.toThrow(/need a `claude setup-token` value/)
  })
})

describe('subscription limit gate', () => {
  test('closes on a rejection until the reported reset, and only then', () => {
    let now = 1_000_000
    const gate = new SubscriptionLimitGate(() => now)
    gate.observe({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 2000, utilization: 0.5 })
    expect(gate.blocked()).toBeNull()
    gate.observe({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 2000, utilization: 1 })
    expect(gate.blocked()).toMatchObject({ code: 'SUBSCRIPTION_LIMIT' })
    now = 2_000_000
    expect(gate.blocked()).toBeNull()
    expect(gate.last()).toMatchObject({ status: 'rejected' })
  })

  test('a rejection without a reset time closes it for a minute', () => {
    let now = 0
    const gate = new SubscriptionLimitGate(() => now)
    gate.observe({ status: 'rejected', rateLimitType: null, resetsAt: null, utilization: null })
    now = 59_000
    expect(gate.blocked()).not.toBeNull()
    now = 60_001
    expect(gate.blocked()).toBeNull()
  })
})
