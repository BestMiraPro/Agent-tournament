import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  accountIdFromTokens,
  CHATGPT_CLIENT_ID,
  ChatGptLogin,
  ChatGptReauthRequired,
  chatGptLoginStatus,
  residencyOf,
  type TokenFetch,
} from '../../src/runtime/chatgpt-oauth.js'

const NOW = 1_800_000_000_000

/** An unsigned JWT with the given claims: only the payload matters to the readers. */
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

function authFile(openai: Record<string, unknown>, others: Record<string, unknown> = { wandb: { type: 'api', key: 'WANDB-KEY' } }) {
  const dir = mkdtempSync(join(tmpdir(), 'arena-chatgpt-'))
  const file = join(dir, 'auth.json')
  writeFileSync(file, JSON.stringify({ ...others, openai }, null, 2), { mode: 0o600 })
  return file
}
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>

/** A fake OpenAI token endpoint that rotates the refresh token on every successful refresh. */
function tokenEndpoint(opts: { status?: number; error?: string; delayMs?: number } = {}) {
  const calls: URLSearchParams[] = []
  let n = 0
  const fetch: TokenFetch = async (url, init) => {
    expect(url).toBe('https://auth.openai.com/oauth/token')
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded')
    calls.push(new URLSearchParams(init.body))
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
    if (opts.status && opts.status !== 200) return { status: opts.status, json: async () => ({ error: opts.error ?? 'invalid_grant' }) }
    n++
    return {
      status: 200,
      json: async () => ({
        access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_compute_residency: 'us' }, n }),
        refresh_token: `refresh-${n + 1}`,
        expires_in: 3600,
      }),
    }
  }
  return { fetch, calls }
}

describe('ChatGPT login status and claims', () => {
  test('reports signed in and expiry without any token', () => {
    const text = JSON.stringify({ openai: { type: 'oauth', refresh: 'r', access: 'a', expires: NOW - 1, accountId: 'x' } })
    const status = chatGptLoginStatus(text, NOW)
    expect(status).toEqual({ signedIn: true, expired: true, expiresAt: NOW - 1 })
    expect(JSON.stringify(status)).not.toContain('"r"')
    expect(chatGptLoginStatus(JSON.stringify({ openai: { type: 'api', key: 'k' } }), NOW).signedIn).toBe(false)
    expect(chatGptLoginStatus(null, NOW).signedIn).toBe(false)
    expect(chatGptLoginStatus('{bad', NOW).signedIn).toBe(false)
  })

  test('reads the account id and residency the way OpenCode does', () => {
    expect(accountIdFromTokens({ id_token: jwt({ chatgpt_account_id: 'from-id' }), access_token: jwt({ chatgpt_account_id: 'from-access' }) })).toBe('from-id')
    expect(accountIdFromTokens({ access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'nested' } }) })).toBe('nested')
    expect(accountIdFromTokens({ access_token: jwt({ organizations: [{ id: 'org-1' }] }) })).toBe('org-1')
    expect(residencyOf(jwt({ chatgpt_compute_residency: 'no_constraint' }))).toBeUndefined()
    expect(residencyOf(jwt({ 'https://api.openai.com/auth': { chatgpt_compute_residency: 'eu' } }))).toBe('eu')
  })
})

describe('ChatGptLogin', () => {
  test('a fresh token in the file is used as is, without refreshing', async () => {
    const file = authFile({ type: 'oauth', refresh: 'refresh-1', access: 'access-1', expires: NOW + 3_600_000, accountId: 'acct-0' })
    const { fetch, calls } = tokenEndpoint()
    const login = new ChatGptLogin({ authFile: file, fetch, now: () => NOW })
    expect(await login.credentials()).toEqual({ access: 'access-1', accountId: 'acct-0' })
    expect(calls).toHaveLength(0)
  })

  test('an expiring token is refreshed with the Codex client id and the rotated pair is written back atomically', async () => {
    const file = authFile({ type: 'oauth', refresh: 'refresh-1', access: 'old', expires: NOW + 60_000 })
    const { fetch, calls } = tokenEndpoint()
    const login = new ChatGptLogin({ authFile: file, fetch, now: () => NOW })
    const creds = await login.credentials()
    expect(creds.accountId).toBe('acct-1')
    expect(calls[0]!.get('grant_type')).toBe('refresh_token')
    expect(calls[0]!.get('refresh_token')).toBe('refresh-1')
    expect(calls[0]!.get('client_id')).toBe(CHATGPT_CLIENT_ID)
    const saved = read(file)
    expect(saved.openai).toMatchObject({ type: 'oauth', refresh: 'refresh-2', access: creds.access, expires: NOW + 3_600_000, accountId: 'acct-1' })
    expect(saved.wandb).toEqual({ type: 'api', key: 'WANDB-KEY' })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('concurrent requests share one refresh', async () => {
    const file = authFile({ type: 'oauth', refresh: 'refresh-1', access: '', expires: 0 })
    const { fetch, calls } = tokenEndpoint({ delayMs: 20 })
    const login = new ChatGptLogin({ authFile: file, fetch, now: () => NOW })
    const all = await Promise.all([login.credentials(), login.credentials(), login.credentials()])
    expect(calls).toHaveLength(1)
    expect(new Set(all.map((c) => c.access)).size).toBe(1)
  })

  test('a token the host OpenCode refreshed meanwhile is adopted instead of refreshed again', async () => {
    const file = authFile({ type: 'oauth', refresh: 'refresh-1', access: '', expires: 0 })
    const { fetch, calls } = tokenEndpoint()
    const login = new ChatGptLogin({ authFile: file, fetch, now: () => NOW })
    // OpenCode on the host rotates the login between two relay requests.
    const host = read(file)
    host.openai = { type: 'oauth', refresh: 'host-refresh', access: 'host-access', expires: NOW + 3_600_000, accountId: 'acct-h' }
    writeFileSync(file, JSON.stringify(host))
    expect(await login.credentials()).toEqual({ access: 'host-access', accountId: 'acct-h' })
    expect(calls).toHaveLength(0)
  })

  test('a refused refresh re-reads the file first, in case OpenCode rotated the token concurrently', async () => {
    const file = authFile({ type: 'oauth', refresh: 'refresh-1', access: '', expires: 0 })
    const fetch: TokenFetch = async () => {
      // OpenCode won the race: it used refresh-1 and saved its rotated pair before our request landed.
      const host = read(file)
      host.openai = { type: 'oauth', refresh: 'host-refresh', access: 'host-access', expires: NOW + 3_600_000 }
      writeFileSync(file, JSON.stringify(host))
      return { status: 400, json: async () => ({ error: 'refresh_token_reused' }) }
    }
    const login = new ChatGptLogin({ authFile: file, fetch, now: () => NOW })
    expect(await login.credentials()).toEqual({ access: 'host-access' })
  })

  test('a refused refresh is final until the login changes: actionable, and never retried in a loop', async () => {
    const file = authFile({ type: 'oauth', refresh: 'dead', access: '', expires: 0 })
    const { fetch, calls } = tokenEndpoint({ status: 401, error: 'invalid_grant' })
    const login = new ChatGptLogin({ authFile: file, fetch, now: () => NOW })
    await expect(login.credentials()).rejects.toThrow(ChatGptReauthRequired)
    await expect(login.credentials()).rejects.toThrow(/opencode auth login.*ChatGPT Plus\/Pro/)
    expect(calls).toHaveLength(1)
    // Signing in again replaces the refresh token, and the login works again.
    writeFileSync(file, JSON.stringify({ openai: { type: 'oauth', refresh: 'new', access: 'fresh', expires: NOW + 3_600_000 } }))
    expect((await login.credentials()).access).toBe('fresh')
  })

  test('a usage limit on the issuer is not a sign-in problem', async () => {
    const file = authFile({ type: 'oauth', refresh: 'r', access: '', expires: 0 })
    const login = new ChatGptLogin({ authFile: file, fetch: tokenEndpoint({ status: 429 }).fetch, now: () => NOW })
    const error = await login.credentials().catch((e: Error) => e)
    expect(error).toMatchObject({ name: 'ChatGptRateLimited' })
    expect((error as Error).message).toMatch(/sign-in is still valid/)
  })

  test.skipIf(process.platform === 'win32')('never refreshes a login it could not save back', async () => {
    const file = authFile({ type: 'oauth', refresh: 'refresh-1', access: '', expires: 0 })
    chmodSync(file, 0o400)
    const { fetch, calls } = tokenEndpoint()
    const login = new ChatGptLogin({ authFile: file, fetch, now: () => NOW })
    await expect(login.credentials()).rejects.toThrow(/read-only here.*losing the rotated token/)
    expect(calls).toHaveLength(0)
    chmodSync(file, 0o600)
  })

  test('the usage-limit gate closes the upstream until the reset', () => {
    let now = NOW
    const login = new ChatGptLogin({ authFile: '/nonexistent', now: () => now })
    expect(login.limited()).toBeNull()
    login.noteLimit(NOW + 60_000)
    expect(login.limited()?.message).toMatch(/usage limit reached/)
    now = NOW + 60_001
    expect(login.limited()).toBeNull()
  })

  test('a missing login says how to sign in', async () => {
    const file = authFile({ type: 'api', key: 'k' })
    await expect(new ChatGptLogin({ authFile: file, now: () => NOW }).credentials()).rejects.toThrow(/no ChatGPT Plus\/Pro login/)
  })
})
