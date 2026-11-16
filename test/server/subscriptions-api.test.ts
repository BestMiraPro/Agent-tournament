import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { buildApi } from '../../src/server/api.js'
import { ClaudeTokenStore } from '../../src/runtime/claude-code/credentials.js'
import { SubscriptionLimitGate } from '../../src/runtime/claude-code/limit-gate.js'
import type { SubscriptionServices } from '../../src/server/subscriptions.js'

const TOKEN = 'sk-ant-oat01-' + 'Zz9_'.repeat(20)

function setup(opts: { cli?: string | null; hostLoggedIn?: boolean; auth?: unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'arena-sub-api-'))
  const tokenFile = join(dir, 'secrets', 'claude-subscription.json')
  const authFile = join(dir, 'auth.json')
  writeFileSync(authFile, JSON.stringify(opts.auth ?? { openai: { type: 'oauth', refresh: 'FAKE-R', access: 'FAKE-A', expires: 1_000, accountId: 'acct' } }))
  const gate = new SubscriptionLimitGate()
  const services: SubscriptionServices = {
    claudeTokens: new ClaudeTokenStore(tokenFile),
    findClaudeCli: () => (opts.cli === undefined ? '/usr/local/bin/claude' : opts.cli),
    claudeHostLogin: async () => ({ loggedIn: opts.hostLoggedIn ?? false, authMethod: opts.hostLoggedIn ? 'claude.ai' : 'none', subscriptionType: null }),
    claudeCliVersion: async () => '2.1.325 (Claude Code)',
    claudeLimitGate: gate,
    chatGptLogin: () => { throw new Error('not used') },
  }
  const app = buildApi({ repos: makeRepos(openDb(':memory:')), manager: {} as never, createRun: () => 'r', subscriptions: services, specDefaults: { authFile } })
  return { app, tokenFile, authFile, gate }
}

describe('subscription API', () => {
  test('reports both sign-ins with no secret in the answer', async () => {
    const { app } = setup({ hostLoggedIn: true })
    const res = await app.inject({ method: 'GET', url: '/api/subscriptions' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.claude).toMatchObject({ cli: { found: true, version: '2.1.325 (Claude Code)' }, tokenSet: false, hostLogin: true, mode: 'host', usage: null })
    expect(body.claude.models).toContain('claude-subscription/claude-opus-5-5')
    expect(body.chatgpt).toMatchObject({ signedIn: true, expired: true, expiresAt: 1000, modelPrefix: 'openai/' })
    expect(res.body).not.toMatch(/FAKE-/)
  })

  test('a pasted setup token is stored 0600 and only ever reported as set; deleting it falls back to the host login', async () => {
    const { app, tokenFile } = setup({ hostLoggedIn: true })
    const put = await app.inject({ method: 'PUT', url: '/api/subscriptions/claude', payload: { token: `${TOKEN.slice(0, 40)}\n  ${TOKEN.slice(40)}` } })
    expect(put.statusCode).toBe(200)
    expect(put.json().claude).toMatchObject({ tokenSet: true, mode: 'token' })
    expect(put.body).not.toContain(TOKEN)
    expect(JSON.parse(readFileSync(tokenFile, 'utf8')).token).toBe(TOKEN)
    const get = await app.inject({ method: 'GET', url: '/api/subscriptions' })
    expect(get.body).not.toContain(TOKEN)
    const del = await app.inject({ method: 'DELETE', url: '/api/subscriptions/claude' })
    expect(del.json().claude).toMatchObject({ tokenSet: false, mode: 'host' })
  })

  test('refuses a value that is not a token, without echoing it', async () => {
    const { app } = setup()
    const res = await app.inject({ method: 'PUT', url: '/api/subscriptions/claude', payload: { token: 'not a token; rm -rf' } })
    expect(res.statusCode).toBe(400)
    expect(res.body).not.toContain('rm -rf')
    expect((await app.inject({ method: 'PUT', url: '/api/subscriptions/claude', payload: {} })).statusCode).toBe(400)
  })

  test('says the CLI is missing, and surfaces the last usage-limit reading', async () => {
    const { app, gate } = setup({ cli: null, auth: {} })
    gate.observe({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 2_000_000_000, utilization: 1 })
    const body = (await app.inject({ method: 'GET', url: '/api/subscriptions' })).json()
    expect(body.claude).toMatchObject({ cli: { found: false, version: null }, hostLogin: false, mode: null, usage: { status: 'rejected', rateLimitType: 'five_hour' } })
    expect(body.chatgpt.signedIn).toBe(false)
  })
})
