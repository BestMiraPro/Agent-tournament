import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, test } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/core/types.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { registerBuiltinConnector, unregisterBuiltinConnector } from '../../src/connectors/builtins.js'
import { GMAIL_READONLY_SCOPE, SLACK_READ_TOOLS } from '../../src/connectors/presets.js'
import { ConnectorStore } from '../../src/connectors/store.js'
import { connectInProcess } from '../../src/connectors/upstream.js'
import { buildApi } from '../../src/server/api.js'
import type { ConnectorRouteDeps } from '../../src/server/connectors-api.js'

const SLACK_TOKEN = 'xoxp-SYNTHETIC-API-TEST-0001'
const GH_TOKEN = 'ghp_SYNTHETICAPITEST0123456789abcd'
const temp: string[] = []
afterEach(() => {
  for (const d of temp.splice(0)) rmSync(d, { recursive: true, force: true })
  unregisterBuiltinConnector('web')
})

function setup(over: Partial<ConnectorRouteDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'arena-connectors-api-'))
  temp.push(dir)
  const store = new ConnectorStore(join(dir, 'connectors'))
  const home = join(dir, 'home')
  mkdirSync(home)
  const repos = makeRepos(openDb(':memory:'))
  const app = buildApi({
    repos,
    manager: { isBusy: () => false, lastError: () => null } as never,
    createRun: () => 'x',
    connectors: {
      store, home, cwd: home,
      // A fake upstream with Slack's read tools plus write tools a real server might offer.
      open: async () => {
        const server = new McpServer({ name: 'fake', version: '1' })
        for (const name of [...SLACK_READ_TOOLS, 'send_message', 'create_issue']) {
          server.registerTool(name, { description: `${name} tool`, inputSchema: {}, annotations: { readOnlyHint: !name.startsWith('send') && !name.startsWith('create') } }, async () => ({ content: [] }))
        }
        return connectInProcess(server)
      },
      ...over,
    },
  })
  return { app, store, home, repos, dir }
}

const post = (app: ReturnType<typeof setup>['app'], url: string, payload: unknown, host = '127.0.0.1:4300') =>
  app.inject({ method: 'POST', url, payload: payload as object, headers: { host } })

describe('connectors API', () => {
  test('adds presets, keeps credentials out of every response, and in the secrets file', async () => {
    const { app, store } = setup()
    const slack = await post(app, '/api/connectors', { preset: 'slack', token: SLACK_TOKEN })
    expect(slack.statusCode).toBe(201)
    const gh = await post(app, '/api/connectors', { preset: 'github', token: GH_TOKEN })
    expect(gh.statusCode).toBe(201)
    const list = await app.inject({ method: 'GET', url: '/api/connectors' })
    const body = JSON.parse(list.body)
    expect(body.connectors.map((c: { id: string }) => c.id)).toEqual(['slack', 'github'])
    expect(body.connectors[0]).toMatchObject({ kind: 'slack', locked: true, connected: true, secretsSet: ['token'], readAllowlist: [...SLACK_READ_TOOLS] })
    expect(body.connectors[1]).toMatchObject({ kind: 'github', locked: false, transport: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } })
    for (const res of [slack, gh, list]) {
      expect(res.body).not.toContain(SLACK_TOKEN)
      expect(res.body).not.toContain(GH_TOKEN)
    }
    expect(readFileSync(join(store.dir, 'connectors.json'), 'utf8')).not.toContain(SLACK_TOKEN)
    expect(store.secrets('slack').token).toBe(SLACK_TOKEN)
  })

  test('Slack and Gmail write tools cannot be permitted; GitHub write tools can', async () => {
    const { app } = setup()
    await post(app, '/api/connectors', { preset: 'slack', token: SLACK_TOKEN })
    await post(app, '/api/connectors', { preset: 'gmail', clientId: 'cid', clientSecret: 'csecret' })
    await post(app, '/api/connectors', { preset: 'github', tokenSource: 'gh-cli' })
    for (const id of ['slack', 'gmail']) {
      const res = await app.inject({ method: 'PATCH', url: `/api/connectors/${id}`, payload: { policy: { writeTools: ['send_message'] } } })
      expect(res.statusCode).toBe(400)
      expect(res.body).toMatch(/read-only/)
    }
    const ok = await app.inject({ method: 'PATCH', url: '/api/connectors/github', payload: { policy: { writeTools: ['create_issue'], disabledTools: ['get_me'] } } })
    expect(ok.statusCode).toBe(200)
    expect(JSON.parse(ok.body).connector.policy).toEqual({ writeTools: ['create_issue'], disabledTools: ['get_me'] })
  })

  test('testing a connection lists its tools, with Slack\'s write tools shown locked', async () => {
    const { app } = setup()
    await post(app, '/api/connectors', { preset: 'slack', token: SLACK_TOKEN })
    const res = await post(app, '/api/connectors/slack/test', {})
    expect(res.statusCode).toBe(200)
    const tools = JSON.parse(res.body).connector.tools as { name: string; classification: string }[]
    expect(tools.find((t) => t.name === 'send_message')!.classification).toBe('locked')
    expect(tools.find((t) => t.name === 'create_issue')!.classification).toBe('locked')
    expect(tools.find((t) => t.name === 'search_messages')!.classification).toBe('read')
  })

  test('a connection that fails says why, redacted', async () => {
    const { app } = setup({ open: async () => { throw new Error(`401 for token=${SLACK_TOKEN}`) } })
    await post(app, '/api/connectors', { preset: 'slack', token: SLACK_TOKEN })
    const res = await post(app, '/api/connectors/slack/test', {})
    expect(res.statusCode).toBe(502)
    expect(res.body).toContain('Slack could not connect')
    expect(res.body).not.toContain(SLACK_TOKEN)
  })

  test('built-ins are listed and testable, and their ids cannot be taken', async () => {
    registerBuiltinConnector({ id: 'web', title: 'Web search', readOnly: true, createServer: () => {
      const s = new McpServer({ name: 'web', version: '1' })
      s.registerTool('search', { inputSchema: {} }, async () => ({ content: [] }))
      return s
    } })
    const { app } = setup()
    const body = JSON.parse((await app.inject({ method: 'GET', url: '/api/connectors' })).body)
    expect(body.builtins).toEqual([{ id: 'web', title: 'Web search', description: '', builtin: true, readOnly: true }])
    expect(JSON.parse((await post(app, '/api/connectors/web/test', {})).body).tools).toEqual([{ name: 'search', description: '', readOnlyHint: null, classification: 'read' }])
    expect((await post(app, '/api/connectors', { preset: 'remote', id: 'web', url: 'https://x.invalid/mcp' })).statusCode).toBe(400)
  })

  test('deleting a connector removes its credentials', async () => {
    const { app, store } = setup()
    await post(app, '/api/connectors', { preset: 'slack', token: SLACK_TOKEN })
    expect((await app.inject({ method: 'DELETE', url: '/api/connectors/slack' })).statusCode).toBe(200)
    expect(store.secrets('slack')).toEqual({})
    expect(readFileSync(join(store.dir, 'secrets.json'), 'utf8')).not.toContain(SLACK_TOKEN)
  })

  test('imports a Claude Code server with its credentials masked in the listing and stored as secrets', async () => {
    const { app, store, home } = setup()
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: 'ctx7sk-SYNTHETIC-0123456789' } } } }))
    const listing = await app.inject({ method: 'GET', url: '/api/connectors/import' })
    expect(listing.body).not.toContain('ctx7sk-SYNTHETIC')
    const [server] = JSON.parse(listing.body).servers
    expect(server).toMatchObject({ name: 'context7', suggestedId: 'context7', imported: false })
    const res = await post(app, '/api/connectors/import', { key: server.key })
    expect(res.statusCode).toBe(201)
    expect(res.body).not.toContain('ctx7sk-SYNTHETIC')
    expect(store.secrets('context7').headers).toEqual({ CONTEXT7_API_KEY: 'ctx7sk-SYNTHETIC-0123456789' })
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/connectors/import' })).body).servers[0].imported).toBe(true)
  })

  test('a run\'s export names its connectors and holds none of their credentials', async () => {
    const { app, store, repos } = setup()
    await post(app, '/api/connectors', { preset: 'slack', token: SLACK_TOKEN })
    const run = repos.runs.create({ name: 'r', config: { ...DEFAULT_CONFIG, sandbox: 'local', connectors: [{ id: 'slack', writeTools: [] }] }, seedDir: null })
    const exported = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/export?format=json` })
    expect(exported.statusCode).toBe(200)
    expect(exported.body).toContain('"connectors":[{"id":"slack","writeTools":[]}]')
    expect(exported.body).not.toContain(SLACK_TOKEN)
    expect(store.secrets('slack').token).toBe(SLACK_TOKEN)
  })
})

describe('Gmail sign-in', () => {
  function googleFetch(scope: string) {
    const calls: URLSearchParams[] = []
    const fetch = (async (_url: string | URL, init: RequestInit = {}) => {
      calls.push(new URLSearchParams(String(init.body)))
      return new Response(JSON.stringify({ access_token: 'ya29.x', refresh_token: 'rt-SYNTHETIC', expires_in: 3600, scope }), { status: 200 })
    }) as typeof globalThis.fetch
    return { fetch, calls }
  }

  test('starts from the dashboard with PKCE and gmail.readonly, and stores only the refresh token it gets back', async () => {
    const g = googleFetch(GMAIL_READONLY_SCOPE)
    const { app, store } = setup({ fetch: g.fetch })
    await post(app, '/api/connectors', { preset: 'gmail', clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret' })
    const start = await post(app, '/api/connectors/gmail/oauth/start', {})
    const url = new URL(JSON.parse(start.body).authorizationUrl)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('scope')).toBe(GMAIL_READONLY_SCOPE)
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4300/api/connectors/oauth/callback')
    const done = await app.inject({ method: 'GET', url: `/api/connectors/oauth/callback?code=c1&state=${url.searchParams.get('state')}` })
    expect(done.statusCode).toBe(200)
    expect(done.body).toContain('Gmail connected')
    expect(g.calls[0]!.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(store.secrets('gmail').google).toMatchObject({ refreshToken: 'rt-SYNTHETIC', scope: GMAIL_READONLY_SCOPE })
    // The state is single-use.
    expect((await app.inject({ method: 'GET', url: `/api/connectors/oauth/callback?code=c1&state=${url.searchParams.get('state')}` })).statusCode).toBe(400)
  })

  test('a grant wider than gmail.readonly is refused and nothing is stored', async () => {
    const { app, store } = setup({ fetch: googleFetch(`${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.modify`).fetch })
    await post(app, '/api/connectors', { preset: 'gmail', clientId: 'cid', clientSecret: 'csecret' })
    const url = new URL(JSON.parse((await post(app, '/api/connectors/gmail/oauth/start', {})).body).authorizationUrl)
    const done = await app.inject({ method: 'GET', url: `/api/connectors/oauth/callback?code=c1&state=${url.searchParams.get('state')}` })
    expect(done.statusCode).toBe(502)
    expect(store.secrets('gmail').google?.refreshToken).toBeUndefined()
  })

  test('sign-in can only start from a loopback dashboard, and an unknown state is refused', async () => {
    const { app } = setup()
    await post(app, '/api/connectors', { preset: 'gmail', clientId: 'cid', clientSecret: 'csecret' })
    expect((await post(app, '/api/connectors/gmail/oauth/start', {}, 'evil.example:4300')).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/connectors/oauth/callback?code=x&state=guessed' })).statusCode).toBe(400)
  })
})

describe('MCP OAuth sign-in for a remote server', () => {
  test('discovers, registers dynamically, sends the browser to sign in, and stores tokens on the way back', async () => {
    const seen: string[] = []
    const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      seen.push(`${init.method ?? 'GET'} ${url.origin}${url.pathname}`)
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json({ resource: 'https://mcp.invalid/mcp', authorization_servers: ['https://auth.invalid'] })
      }
      if (url.origin === 'https://auth.invalid' && url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        return json({
          issuer: 'https://auth.invalid', authorization_endpoint: 'https://auth.invalid/authorize', token_endpoint: 'https://auth.invalid/token',
          registration_endpoint: 'https://auth.invalid/register', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
        })
      }
      if (url.href === 'https://auth.invalid/register') return json({ ...JSON.parse(String(init.body)), client_id: 'client-1' }, 201)
      if (url.href === 'https://auth.invalid/token') return json({ access_token: 'at-SYNTHETIC', token_type: 'Bearer', refresh_token: 'rt-SYNTHETIC', expires_in: 3600 })
      return new Response('not found', { status: 404 })
    }) as typeof globalThis.fetch
    const { app, store } = setup({ fetch })
    await post(app, '/api/connectors', { preset: 'remote', id: 'remote1', url: 'https://mcp.invalid/mcp' })
    const start = await post(app, '/api/connectors/remote1/oauth/start', {})
    expect(start.statusCode).toBe(200)
    const url = new URL(JSON.parse(start.body).authorizationUrl)
    expect(url.origin + url.pathname).toBe('https://auth.invalid/authorize')
    expect(url.searchParams.get('client_id')).toBe('client-1')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4300/api/connectors/oauth/callback')
    const done = await app.inject({ method: 'GET', url: `/api/connectors/oauth/callback?code=c1&state=${url.searchParams.get('state')}` })
    expect(done.statusCode).toBe(200)
    expect(store.secrets('remote1').mcpOauth?.tokens).toMatchObject({ access_token: 'at-SYNTHETIC' })
    expect(seen).toContain('POST https://auth.invalid/register')
    expect(seen).toContain('POST https://auth.invalid/token')
    const listed = await app.inject({ method: 'GET', url: '/api/connectors' })
    expect(listed.body).not.toContain('at-SYNTHETIC')
    expect(JSON.parse(listed.body).connectors[0].connected).toBe(true)
  })
})
