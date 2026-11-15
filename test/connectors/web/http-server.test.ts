import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { request } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import type { WebCallRecord } from '../../../src/connectors/web/evidence.js'
import { startWebToolHost, type WebToolHostHandle } from '../../../src/connectors/web/http-server.js'
import { webConnector } from '../../../src/connectors/web/mcp-server.js'
import { LANGSEARCH_URL, type HttpPost } from '../../../src/connectors/web/search.js'

const post: HttpPost = async (req) => {
  if (req.url !== LANGSEARCH_URL) throw new Error('unexpected')
  return { status: 200, body: JSON.stringify({ code: 200, data: { webPages: { value: [{ name: 'r', url: 'https://r.example/', snippet: 's' }] } } }) }
}

let handle: WebToolHostHandle | null = null
afterEach(async () => { await handle?.close(); handle = null })

async function start() {
  handle = await startWebToolHost({ connector: webConnector({ keys: () => ({ langsearch: 'k', exa: null }), post }) })
  return handle
}

function raw(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? 'POST', headers: opts.headers }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => { body += c.toString() })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

async function clientFor(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'agent', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  return client
}

describe('web tool host', () => {
  test('listens on loopback and serves an attached run to its agents, attributing every call', async () => {
    const h = await start()
    expect(h.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const records: WebCallRecord[] = []
    const grant = h.host.grant()
    grant.attach('run-7', (r) => records.push(r))
    const client = await clientFor(h.url, grant.tokenFor('agent-a'))
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['web_fetch', 'web_search'])
    const result = await client.callTool({ name: 'web_search', arguments: { query: 'hello' } })
    expect(result.isError).toBeFalsy()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ runId: 'run-7', agentId: 'agent-a', tool: 'web_search', outcome: 'completed' })
    await client.close()
  })

  test('refuses missing, malformed, forged and unattached tokens', async () => {
    const h = await start()
    const grant = h.host.grant()
    const unattached = grant.tokenFor('agent-a')
    expect((await raw(h.url, { headers: { ...mcpHeaders, authorization: `Bearer ${unattached}` }, body: initialize })).status).toBe(401)
    grant.attach('run-1', () => {})
    const good = grant.tokenFor('agent-a')
    const [id, , mac] = good.split('.')
    for (const token of [null, 'garbage', `${id}.agent-b.${mac}`, `${id}.agent-a.${'0'.repeat(mac!.length)}`, `nope.agent-a.${mac}`, `${id}.agent/../x.${mac}`]) {
      const headers = token === null ? mcpHeaders : { ...mcpHeaders, authorization: `Bearer ${token}` }
      expect((await raw(h.url, { headers, body: initialize })).status, String(token)).toBe(401)
    }
    expect((await raw(h.url, { headers: { ...mcpHeaders, authorization: `Bearer ${good}` }, body: initialize })).status).toBe(200)
  })

  test('a revoked run is refused, and its open servers stop answering', async () => {
    const h = await start()
    const records: WebCallRecord[] = []
    const grant = h.host.grant()
    grant.attach('run-2', (r) => records.push(r))
    const token = grant.tokenFor('agent-a')
    const client = await clientFor(h.url, token)
    grant.revoke()
    expect((await raw(h.url, { headers: { ...mcpHeaders, authorization: `Bearer ${token}` }, body: initialize })).status).toBe(401)
    await expect(client.callTool({ name: 'web_search', arguments: { query: 'x' } })).rejects.toThrow()
    expect(records).toEqual([])
  })

  test('only POST /mcp from the loopback host name, with a bounded body', async () => {
    const h = await start()
    const grant = h.host.grant()
    grant.attach('run-3', () => {})
    const auth = { ...mcpHeaders, authorization: `Bearer ${grant.tokenFor('a')}` }
    expect((await raw(h.url, { method: 'GET', headers: auth })).status).toBe(405)
    expect((await raw(h.url.replace('/mcp', '/other'), { headers: auth, body: initialize })).status).toBe(404)
    expect((await raw(h.url, { headers: { ...auth, host: 'evil.example' }, body: initialize })).status).toBe(403)
    expect((await raw(h.url, { headers: auth, body: 'x'.repeat(70 * 1024) })).status).toBe(413)
    expect((await raw(h.url, { headers: auth, body: '{not json' })).status).toBe(400)
  })
})
