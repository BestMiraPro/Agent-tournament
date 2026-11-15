import { request } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { codexBody, RelayPolicy, type ChatGptCredentialSource, type RelayUpstream } from '../../src/runtime/provider-relay.js'
import { startProviderRelay, type RelayRecord, type UpstreamCall } from '../../src/runtime/provider-relay-server.js'
import { relayUpstreamsFromAuth } from '../../src/runtime/relay-credentials.js'
import { ChatGptRateLimited, ChatGptReauthRequired } from '../../src/runtime/chatgpt-oauth.js'

const limits = { maxRequestBytes: 64 * 1024, maxResponseBytes: 64 * 1024 }
const json = (body: unknown) => Buffer.from(JSON.stringify(body))
const access = `h.${Buffer.from(JSON.stringify({ chatgpt_compute_residency: 'us' })).toString('base64url')}.s`

function source(over: Partial<ChatGptCredentialSource> = {}) {
  const notes: number[] = []
  const src: ChatGptCredentialSource = {
    credentials: async () => ({ access, accountId: 'acct-1' }),
    limited: () => null,
    noteLimit: (t) => { notes.push(t) },
    ...over,
  }
  return { notes, src }
}

function subUpstreams(src: ChatGptCredentialSource): RelayUpstream[] {
  return [
    { providerId: 'claude-subscription', baseUrl: 'https://api.anthropic.com', authStyle: 'bearer', apiKey: 'REAL-SETUP-TOKEN', kind: 'claude-subscription' },
    { providerId: 'openai', baseUrl: 'https://chatgpt.com/backend-api/codex/responses', authStyle: 'bearer', apiKey: '', kind: 'chatgpt', chatgpt: src },
  ]
}

function subPolicy(src: ChatGptCredentialSource): RelayPolicy {
  const p = new RelayPolicy([], limits)
  p.grant('run-s', {
    token: 'run-tok', maxRequests: 5,
    allowedModels: ['claude-subscription/claude-opus-5-5', 'openai/gpt-5.5'],
    upstreams: subUpstreams(src),
  })
  return p
}

/** What Claude Code 2.1.325 sent to a fake upstream through ANTHROPIC_BASE_URL with an OAuth token. */
const claudeHeaders = {
  authorization: 'Bearer run-tok', 'content-type': 'application/json', 'anthropic-version': '2023-06-01',
  'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20', 'user-agent': 'claude-cli/2.1.325 (external, sdk-cli)',
  'x-app': 'cli', 'x-claude-code-session-id': 'e0b82d40-0c53-4d96-be6f-27456f496021', 'anthropic-dangerous-direct-browser-access': 'true',
  'x-stainless-os': 'MacOS', cookie: 'c=1',
}

/** What opencode 1.18.21 sent to `openai` in key mode (a protected worker), captured from the agent image. */
const openCodeHeaders = {
  authorization: 'Bearer run-tok', 'content-type': 'application/json', originator: 'opencode',
  'user-agent': 'opencode/1.18.21 (linux 7.0.14-linuxkit; arm64) ai-sdk/provider-utils/4.0.38 runtime/bun/1.3.14',
  'session-id': 'ses_1', 'x-session-affinity': 'ses_1', 'x-session-id': 'ses_1',
}
const openCodeBody = {
  model: 'gpt-5.5',
  input: [{ role: 'developer', content: 'You are OpenCode.' }, { role: 'user', content: [{ type: 'input_text', text: 'Say OK' }] }],
  store: false, include: ['reasoning.encrypted_content'], reasoning: { effort: 'medium', summary: 'auto' }, stream: true,
}

describe('relay credentials for subscription logins', () => {
  const cat = { openai: { api: null, npm: '@ai-sdk/openai' }, anthropic: { api: null, npm: '@ai-sdk/anthropic' } }
  const auth = JSON.stringify({
    openai: { type: 'oauth', refresh: 'FAKE-REFRESH', access: 'FAKE-ACCESS', expires: 1, accountId: 'acct' },
    anthropic: { type: 'oauth', refresh: 'FAKE-R', access: 'FAKE-A', expires: 1 },
  })

  test('carries the ChatGPT Plus/Pro login for openai through the refreshing source, to the Codex backend', () => {
    const { src } = source()
    const { upstreams, unsupported } = relayUpstreamsFromAuth(auth, cat, ['openai'], { chatgpt: src })
    expect(unsupported).toEqual([])
    expect(upstreams).toEqual([{ providerId: 'openai', baseUrl: 'https://chatgpt.com/backend-api/codex/responses', authStyle: 'bearer', apiKey: '', kind: 'chatgpt', chatgpt: src }])
    expect(JSON.stringify(upstreams)).not.toContain('FAKE-')
  })

  test('every other OAuth login is still refused, and so is ChatGPT without a refreshing source', () => {
    const { src } = source()
    expect(relayUpstreamsFromAuth(auth, cat, ['anthropic'], { chatgpt: src }).unsupported[0]!.reason).toMatch(/OAuth login, which the relay cannot carry/)
    expect(relayUpstreamsFromAuth(auth, cat, ['openai']).unsupported[0]!.reason).toMatch(/OAuth login, which the relay cannot carry/)
  })

  test('carries claude-subscription only with a setup token, never the host login', () => {
    expect(relayUpstreamsFromAuth('{}', cat, ['claude-subscription'], { claudeToken: 'FAKE-CLAUDE-TOKEN' }).upstreams).toEqual([
      { providerId: 'claude-subscription', baseUrl: 'https://api.anthropic.com', authStyle: 'bearer', apiKey: 'FAKE-CLAUDE-TOKEN', kind: 'claude-subscription' },
    ])
    expect(relayUpstreamsFromAuth('{}', cat, ['claude-subscription']).unsupported[0]!.reason).toMatch(/needs a `claude setup-token` value/)
  })
})

describe('relay policy for subscription upstreams', () => {
  test("forwards Claude Code's own message calls with the setup token swapped in", () => {
    const d = subPolicy(source().src).authorize({
      method: 'POST', path: '/claude-subscription/v1/messages?beta=true', headers: claudeHeaders, body: json({ model: 'claude-opus-5-5', messages: [] }),
    })
    if (!d.ok) throw new Error(d.error)
    expect(d).toMatchObject({ modelId: 'claude-subscription/claude-opus-5-5', url: 'https://api.anthropic.com/v1/messages?beta=true' })
    expect(d.headers).toEqual({
      authorization: 'Bearer REAL-SETUP-TOKEN', 'content-type': 'application/json', 'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20', 'user-agent': 'claude-cli/2.1.325 (external, sdk-cli)',
      'x-app': 'cli', 'x-claude-code-session-id': 'e0b82d40-0c53-4d96-be6f-27456f496021', 'anthropic-dangerous-direct-browser-access': 'true',
    })
  })

  test('the Claude upstream is only /v1/messages: other paths, queries and models outside the roster are refused', () => {
    const p = subPolicy(source().src)
    const call = (path: string, model = 'claude-opus-5-5') => p.authorize({ method: 'POST', path, headers: claudeHeaders, body: json({ model }) })
    expect(call('/claude-subscription/v1/messages/count_tokens?beta=true')).toMatchObject({ ok: true })
    expect(call('/claude-subscription/api/oauth/profile')).toMatchObject({ ok: false, status: 404 })
    expect(call('/claude-subscription/v1/messages?beta=true&x=1')).toMatchObject({ ok: false, status: 404 })
    expect(call('/claude-subscription/v1/messages', 'claude-haiku-5-5')).toMatchObject({ ok: false, status: 403 })
  })

  test('ChatGPT calls go to the Codex backend with a fresh token, account and residency, and the system prompt as instructions', async () => {
    const d = subPolicy(source().src).authorize({ method: 'POST', path: '/openai/responses', headers: openCodeHeaders, body: json(openCodeBody) })
    if (!d.ok) throw new Error(d.error)
    expect(d.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    const { input: _input, ...rest } = openCodeBody
    expect(JSON.parse(d.body.toString())).toEqual({ ...rest, instructions: 'You are OpenCode.', input: [openCodeBody.input[1]] })
    expect(d.headers).toEqual({
      'content-type': 'application/json', originator: 'opencode', 'user-agent': openCodeHeaders['user-agent'],
      'session-id': 'ses_1', 'x-session-affinity': 'ses_1', 'x-session-id': 'ses_1',
    })
    expect(await d.prepare!()).toEqual({ authorization: `Bearer ${access}`, 'chatgpt-account-id': 'acct-1', 'x-openai-internal-codex-residency': 'us' })
  })

  test('an upstream 429 closes the ChatGPT upstream; while it is closed, calls are refused without going upstream', () => {
    const open = source()
    const d = subPolicy(open.src).authorize({ method: 'POST', path: '/openai/responses', headers: { authorization: 'Bearer run-tok' }, body: json({ model: 'gpt-5.5', input: [] }) })
    if (!d.ok) throw new Error(d.error)
    d.onReply!(429, { 'retry-after': '120' })
    expect(open.notes[0]! - Date.now()).toBeGreaterThan(115_000)
    const closed = subPolicy(source({ limited: () => ({ message: 'ChatGPT subscription usage limit reached; it resets at x' }) }).src)
    expect(closed.authorize({ method: 'POST', path: '/openai/responses', headers: { authorization: 'Bearer run-tok' }, body: json({ model: 'gpt-5.5', input: [] }) }))
      .toMatchObject({ ok: false, status: 429, error: expect.stringMatching(/usage limit reached/) })
  })

  test('the ChatGPT upstream carries only Responses calls', () => {
    const p = subPolicy(source().src)
    expect(p.authorize({ method: 'POST', path: '/openai/chat/completions', headers: { authorization: 'Bearer run-tok' }, body: json({ model: 'gpt-5.5' }) }))
      .toMatchObject({ ok: false, status: 404 })
  })

  test('codexBody leaves a body that already has instructions, or none to move, alone', () => {
    expect(codexBody({ instructions: 'x', input: [{ role: 'developer', content: 'y' }] })).toEqual({ instructions: 'x', input: [{ role: 'developer', content: 'y' }] })
    expect(codexBody({ input: [{ role: 'user', content: 'u' }] })).toEqual({ input: [{ role: 'user', content: 'u' }] })
    expect(codexBody({ input: [{ role: 'system', content: [{ type: 'input_text', text: 'a' }] }, { role: 'developer', content: 'b' }, { role: 'user', content: 'u' }] }))
      .toEqual({ instructions: 'a\nb', input: [{ role: 'user', content: 'u' }] })
  })
})

describe('relay server with a refreshing credential', () => {
  const closers: (() => Promise<void>)[] = []
  afterEach(async () => { for (const c of closers.splice(0)) await c() })

  const post = (port: number, path: string, headers: Record<string, string>, payload: Buffer) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
      })
      req.on('error', reject)
      req.end(payload)
    })

  async function serve(src: ChatGptCredentialSource, upstream: UpstreamCall) {
    const records: RelayRecord[] = []
    const relay = await startProviderRelay({ policy: subPolicy(src), upstream, onRequest: (r) => records.push(r) })
    closers.push(relay.close)
    return { relay, records }
  }

  test('sends the resolved token upstream; the run token never leaves', async () => {
    const seen: Record<string, string>[] = []
    const { relay } = await serve(source().src, async (_url, init) => {
      seen.push(init.headers)
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: (async function* () { yield Buffer.from('data: ok\n\n') })() }
    })
    const res = await post(relay.port, '/openai/responses', openCodeHeaders, json(openCodeBody))
    expect(res).toEqual({ status: 200, body: 'data: ok\n\n' })
    expect(seen[0]!.authorization).toBe(`Bearer ${access}`)
    expect(JSON.stringify(seen)).not.toContain('run-tok')
  })

  test('an expired sign-in and a usage limit come back as distinct, actionable errors', async () => {
    let calls = 0
    const upstream: UpstreamCall = async () => { calls++; throw new Error('must not be called') }
    const reauth = await serve(source({ credentials: async () => { throw new ChatGptReauthRequired() } }).src, upstream)
    const r1 = await post(reauth.relay.port, '/openai/responses', openCodeHeaders, json(openCodeBody))
    expect(r1.status).toBe(401)
    expect(JSON.parse(r1.body).error).toMatch(/opencode auth login/)
    const limited = await serve(source({ credentials: async () => { throw new ChatGptRateLimited(Date.now() + 1000) } }).src, upstream)
    const r2 = await post(limited.relay.port, '/openai/responses', openCodeHeaders, json(openCodeBody))
    expect(r2.status).toBe(429)
    expect(JSON.parse(r2.body).error).toMatch(/sign-in is still valid/)
    expect(calls).toBe(0)
    expect(reauth.records[0]).toMatchObject({ status: 401, outcome: 'refused' })
  })
})
