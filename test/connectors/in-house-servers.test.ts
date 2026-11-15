import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, test } from 'vitest'
import { GMAIL_READ_TOOLS, GMAIL_READONLY_SCOPE, SLACK_READ_TOOLS } from '../../src/connectors/presets.js'
import { createSlackMcpServer, slackApi, SLACK_READ_METHODS, type SlackCall } from '../../src/connectors/slack/server.js'
import { createGmailMcpServer, gmailApi, type GmailGet } from '../../src/connectors/gmail/server.js'
import { exchangeGoogleCode, googleAccessTokens, googleAuthUrl, refreshGoogleToken } from '../../src/connectors/gmail/oauth.js'
import { pkcePair } from '../../src/connectors/oauth.js'

async function connect(server: McpServer): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(b)
  return client
}

const fakeFetch = (respond: (url: string, init: RequestInit) => unknown, seen: { url: string; init: RequestInit }[]) =>
  (async (url: string | URL, init: RequestInit = {}) => {
    seen.push({ url: String(url), init })
    const body = respond(String(url), init)
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

describe('in-house Slack server', () => {
  test('offers exactly the locked read tools, each annotated read-only', async () => {
    const client = await connect(createSlackMcpServer({ call: async () => ({ ok: true }) }))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...SLACK_READ_TOOLS].sort())
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true)
  })

  test('every tool calls only read methods', async () => {
    const called: string[] = []
    const call: SlackCall = async (method) => {
      called.push(method)
      return { ok: true, messages: { matches: [] }, channels: [], members: [], user: {} }
    }
    const client = await connect(createSlackMcpServer({ call }))
    const args: Record<string, Record<string, unknown>> = {
      search_messages: { query: 'q' }, list_channels: {}, read_channel: { channel: 'C1' },
      read_thread: { channel: 'C1', ts: '1.2' }, get_user: { user: 'U1' }, list_users: {},
    }
    for (const name of SLACK_READ_TOOLS) {
      const result = await client.callTool({ name, arguments: args[name] })
      expect(result.isError ?? false).toBe(false)
    }
    expect(called.every((m) => (SLACK_READ_METHODS as readonly string[]).includes(m))).toBe(true)
    expect(new Set(called).size).toBe(SLACK_READ_METHODS.length)
  })

  test('the HTTP client refuses a write method before any request, and sends the token only as a header', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const call = slackApi({ token: () => 'xoxp-SYNTHETIC', fetch: fakeFetch(() => ({ ok: true }), seen) })
    for (const write of ['chat.postMessage', 'chat.scheduleMessage', 'reactions.add', 'chat.delete', 'files.upload']) {
      await expect(call(write as never, {})).rejects.toThrow(/not a read method/)
    }
    expect(seen).toHaveLength(0)
    await call('conversations.list', { limit: 5 })
    expect(seen[0]!.url).toBe('https://slack.com/api/conversations.list?limit=5')
    expect(seen[0]!.init.method).toBe('GET')
    expect(seen[0]!.url).not.toContain('SYNTHETIC')
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer xoxp-SYNTHETIC')
  })

  test('a Slack error code becomes a tool error without the token', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const call = slackApi({ token: () => 'xoxp-SYNTHETIC', fetch: fakeFetch(() => ({ ok: false, error: 'not_authed' }), seen) })
    const client = await connect(createSlackMcpServer({ call }))
    const result = await client.callTool({ name: 'list_channels', arguments: {} })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('not_authed')
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC')
  })
})

describe('in-house Gmail server', () => {
  test('offers exactly the locked read tools, each annotated read-only', async () => {
    const client = await connect(createGmailMcpServer({ get: async () => ({}) }))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...GMAIL_READ_TOOLS].sort())
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true)
  })

  test('tools read messages, threads and labels, decoding text bodies', async () => {
    const paths: string[] = []
    const body = Buffer.from('Hello from the test').toString('base64url')
    const get: GmailGet = async (path) => {
      paths.push(path)
      if (path === 'users/me/messages') return { messages: [{ id: 'a1', threadId: 'b1' }] }
      if (path === 'users/me/labels') return { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] }
      const msg = { id: 'a1', threadId: 'b1', snippet: 's', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Hi' }], body: { data: body } } }
      if (path.startsWith('users/me/threads/')) return { id: 'b1', messages: [msg] }
      return msg
    }
    const client = await connect(createGmailMcpServer({ get }))
    const search = await client.callTool({ name: 'search_messages', arguments: { query: 'from:me' } })
    expect(JSON.stringify(search)).toContain('Hi')
    const one = await client.callTool({ name: 'get_message', arguments: { id: 'a1' } })
    expect(JSON.stringify(one)).toContain('Hello from the test')
    await client.callTool({ name: 'get_thread', arguments: { id: 'b1' } })
    await client.callTool({ name: 'list_labels', arguments: {} })
    expect(paths).toEqual(['users/me/messages', 'users/me/messages/a1', 'users/me/messages/a1', 'users/me/threads/b1', 'users/me/labels'])
  })

  test('the HTTP client only GETs read paths', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const get = gmailApi({ accessToken: async () => 'ya29.SYNTHETIC', fetch: fakeFetch(() => ({}), seen) })
    for (const bad of ['users/me/messages/send', 'users/me/drafts', 'users/me/messages/a1/modify', 'users/me/messages/a1/trash', 'users/me/messages/import', 'users/me/messages/batchDelete', 'users/other/messages', 'users/me/settings/filters', '../x']) {
      await expect(get(bad)).rejects.toThrow(/not a read path/)
    }
    expect(seen).toHaveLength(0)
    await get('users/me/labels')
    expect(seen[0]!.init.method).toBe('GET')
    expect(seen[0]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/labels')
  })
})

describe('Google OAuth for Gmail', () => {
  test('asks for gmail.readonly only, with an S256 PKCE challenge and offline access', () => {
    const { challenge } = pkcePair()
    const url = new URL(googleAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:4300/api/connectors/oauth/callback', state: 'st', codeChallenge: challenge }))
    expect(url.searchParams.get('scope')).toBe(GMAIL_READONLY_SCOPE)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(challenge)
    expect(url.searchParams.get('access_type')).toBe('offline')
  })

  test('refuses a grant wider than gmail.readonly and keeps nothing', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const wide = fakeFetch(() => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: `${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.send` }), seen)
    await expect(exchangeGoogleCode({ clientId: 'c', clientSecret: 's', code: 'x', codeVerifier: 'v', redirectUri: 'r', fetch: wide })).rejects.toThrow(/other than/)
    const exact = fakeFetch(() => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: GMAIL_READONLY_SCOPE }), seen)
    const tokens = await exchangeGoogleCode({ clientId: 'c', clientSecret: 's', code: 'x', codeVerifier: 'v', redirectUri: 'r', fetch: exact, now: () => 0 })
    expect(tokens).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 3_600_000, scope: GMAIL_READONLY_SCOPE })
    const sent = new URLSearchParams(String(seen.at(-1)!.init.body))
    expect(sent.get('code_verifier')).toBe('v')
    expect(sent.get('grant_type')).toBe('authorization_code')
  })

  test('refreshes host-side once per expiry, sharing one refresh between callers', async () => {
    let t = 0
    let refreshes = 0
    const seen: { url: string; init: RequestInit }[] = []
    const doFetch = fakeFetch(() => ({ access_token: `a${++refreshes}`, expires_in: 120, scope: GMAIL_READONLY_SCOPE }), seen)
    const token = googleAccessTokens(() => refreshGoogleToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetch: doFetch, now: () => t }), () => t)
    expect(await Promise.all([token(), token()])).toEqual(['a1', 'a1'])
    t = 30_000
    expect(await token()).toBe('a1')
    t = 70_000
    expect(await token()).toBe('a2')
    expect(new URLSearchParams(String(seen[0]!.init.body)).get('grant_type')).toBe('refresh_token')
  })
})
