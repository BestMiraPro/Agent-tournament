import { createServer, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { afterEach, describe, expect, test } from 'vitest'
import { NeedsSignInError } from '../../src/connectors/mcp-oauth.js'
import { SLACK_READ_TOOLS } from '../../src/connectors/presets.js'
import { openStoredUpstream } from '../../src/connectors/resolve.js'
import { ConnectorStore, newConnectorRecord } from '../../src/connectors/store.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'arena-resolve-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, store: new ConnectorStore(join(dir, 'connectors')) }
}

const sdk = (path: string) => pathToFileURL(join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm', path)).href

describe('opening stored connectors on the host', () => {
  test('stdio: credentials reach the child only through its own environment and arguments; the app\'s environment does not', async () => {
    const { dir, store } = tempStore()
    const script = join(dir, 'server.mjs')
    writeFileSync(script, [
      `import { McpServer } from ${JSON.stringify(sdk('server/mcp.js'))}`,
      `import { StdioServerTransport } from ${JSON.stringify(sdk('server/stdio.js'))}`,
      "const server = new McpServer({ name: 'env', version: '1' })",
      "server.registerTool('report', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: JSON.stringify({",
      '  token: process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? null, readOnly: process.env.GITHUB_READ_ONLY ?? null,',
      '  extra: process.env.EXTRA_SECRET ?? null, plain: process.env.PLAIN ?? null, leak: process.env.ARENA_TEST_LEAK ?? null,',
      '  argv: process.argv.slice(2) }) }] }))',
      'await server.connect(new StdioServerTransport())',
    ].join('\n'))
    process.env.ARENA_TEST_LEAK = 'app-only-secret'
    cleanups.push(() => { delete process.env.ARENA_TEST_LEAK })
    const record = store.create(newConnectorRecord({
      id: 'gh-local', title: 'GitHub', kind: 'github',
      transport: { type: 'stdio', command: process.execPath, args: [script, '--key', '${ARENA_SECRET_ARG_1}'], env: { PLAIN: 'p' }, secretEnv: ['EXTRA_SECRET'] },
      auth: { type: 'token', source: 'manual' },
    }, 1), { token: 'ghp_SYNTHETIC-STDIO', env: { EXTRA_SECRET: 'e-SYNTHETIC' }, args: { ARENA_SECRET_ARG_1: 'arg-SYNTHETIC' } })
    const upstream = await openStoredUpstream(store, record)
    cleanups.push(() => upstream.close())
    const result = await upstream.callTool('report', {}, { timeoutMs: 10_000 })
    const report = JSON.parse((result.content as { text: string }[])[0]!.text)
    expect(report).toEqual({ token: 'ghp_SYNTHETIC-STDIO', readOnly: '1', extra: 'e-SYNTHETIC', plain: 'p', leak: null, argv: ['--key', 'arg-SYNTHETIC'] })
  }, 30_000)

  test('http: the token is a bearer header, GitHub is asked for read-only mode, secret headers are added', async () => {
    const { store } = tempStore()
    const seen: IncomingHttpHeaders[] = []
    const http: HttpServer = createServer(async (req, res) => {
      seen.push(req.headers)
      const server = new McpServer({ name: 'remote', version: '1' })
      server.registerTool('search_code', { inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [] }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => { void transport.close(); void server.close() })
      await server.connect(transport)
      await transport.handleRequest(req, res)
    })
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
    cleanups.push(() => new Promise<void>((r) => { http.closeAllConnections(); http.close(() => r()) }))
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`
    const record = store.create(newConnectorRecord({
      id: 'gh', title: 'GitHub', kind: 'github', transport: { type: 'http', url, headers: { 'X-Plain': 'p' }, secretHeaders: ['X-Api-Key'] },
      auth: { type: 'token', source: 'manual' },
    }, 1), { token: 'ghp_SYNTHETIC-HTTP', headers: { 'X-Api-Key': 'k-SYNTHETIC' } })
    const upstream = await openStoredUpstream(store, record)
    cleanups.push(() => upstream.close())
    expect((await upstream.listTools()).map((t) => t.name)).toEqual(['search_code'])
    expect(seen[0]).toMatchObject({ authorization: 'Bearer ghp_SYNTHETIC-HTTP', 'x-mcp-readonly': 'true', 'x-plain': 'p', 'x-api-key': 'k-SYNTHETIC' })

    // Once a write tool is permitted, read-only mode is no longer requested.
    const writable = store.update('gh', (r) => ({ ...r, policy: { disabledTools: [], writeTools: ['create_issue'] } }))
    seen.length = 0
    const second = await openStoredUpstream(store, writable)
    cleanups.push(() => second.close())
    expect(seen[0]!['x-mcp-readonly']).toBeUndefined()
  })

  test('gh-cli: the token is read when the connector opens, never stored', async () => {
    const { store } = tempStore()
    const record = store.create(newConnectorRecord({ id: 'gh', title: 'GitHub', kind: 'github', transport: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: {}, secretHeaders: [] }, auth: { type: 'token', source: 'gh-cli' } }, 1))
    let asked = 0
    await expect(openStoredUpstream(store, record, { ghToken: async () => { asked++; throw new Error('gh not logged in') } })).rejects.toThrow(/gh not logged in/)
    expect(asked).toBe(1)
    expect(store.secrets('gh')).toEqual({})
  })

  test('Slack opens the in-house read-only server; Gmail without a sign-in asks for one', async () => {
    const { store } = tempStore()
    const slack = store.create(newConnectorRecord({ id: 'slack', title: 'Slack', kind: 'slack', transport: { type: 'slack' }, auth: { type: 'token', source: 'manual' } }, 1), { token: 'xoxp-SYNTHETIC' })
    const upstream = await openStoredUpstream(store, slack, { fetch: (async () => new Response('{"ok":true}')) as typeof fetch })
    cleanups.push(() => upstream.close())
    expect((await upstream.listTools()).map((t) => t.name).sort()).toEqual([...SLACK_READ_TOOLS].sort())
    const gmail = store.create(newConnectorRecord({ id: 'gmail', title: 'Gmail', kind: 'gmail', transport: { type: 'gmail' }, auth: { type: 'oauth-google' } }, 1), { google: { clientId: 'c', clientSecret: 's' } })
    await expect(openStoredUpstream(store, gmail)).rejects.toBeInstanceOf(NeedsSignInError)
  })
})
