import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolBridge } from './bridge.js'
import { CONNECTOR_ID } from './types.js'

export interface ToolBridgeServer {
  host: string
  port: number
  close(): Promise<void>
}

const sendJson = (res: ServerResponse, status: number, error: string, extra: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...extra })
  res.end(JSON.stringify({ error }))
}

function bearer(req: IncomingMessage): string | null {
  const value = req.headers.authorization
  const match = typeof value === 'string' ? /^Bearer (\S+)$/.exec(value) : null
  return match ? match[1]! : null
}

/**
 * The bridge's HTTP face: one MCP endpoint per connector at `/mcp/<connectorId>`, Streamable HTTP, stateless, JSON
 * responses. Credentials never leave this process; workers present only their per-agent token. Loopback by default;
 * protected workers reach it through their gateway's tools route.
 *
 * Each POST gets a fresh MCP server bound to the caller and connector, serving only `tools/list` and `tools/call`
 * from the bridge's policy. No session state, no GET stream, no resources or prompts.
 */
export async function startToolBridgeServer(opts: {
  bridge: ToolBridge
  host?: string
  port?: number
  /** Do not keep the process alive for the bridge alone. */
  unref?: boolean
}): Promise<ToolBridgeServer> {
  const host = opts.host ?? '127.0.0.1'
  const { bridge } = opts
  const maxBody = bridge.limits.maxRequestBytes

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const raw = req.url ?? ''
    const match = /^\/mcp\/([^/?#]+)$/.exec(raw)
    if (!match || !CONNECTOR_ID.test(match[1]!)) return sendJson(res, 404, 'not a connector endpoint')
    const connectorId = match[1]!
    const caller = bridge.authenticate(bearer(req))
    if (!caller) return sendJson(res, 401, 'missing or unknown connector token')
    if (!bridge.hasConnector(caller, connectorId)) return sendJson(res, 404, 'this connector is not enabled for this run')
    if (req.method !== 'POST') return sendJson(res, 405, 'only POST is served', { allow: 'POST' })

    const chunks: Buffer[] = []
    let received = 0
    try {
      for await (const chunk of req as AsyncIterable<Buffer>) {
        received += chunk.length
        if (received > maxBody) return sendJson(res, 413, `request body exceeds ${maxBody} bytes`)
        chunks.push(chunk)
      }
    } catch {
      res.destroy()
      return
    }
    let body: unknown
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return sendJson(res, 400, 'request body is not JSON')
    }

    const server = new Server({ name: 'agent-tournament-tool-bridge', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: bridge.listTools(caller, connectorId) }))
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      bridge.callTool(caller, connectorId, request.params.name, request.params.arguments ?? {}))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close().catch(() => {})
      void server.close().catch(() => {})
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch {
      if (!res.headersSent) sendJson(res, 500, 'connector request failed')
      else res.destroy()
    }
  }

  const server = createServer((req, res) => { void handle(req, res) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, host, () => resolve())
  })
  if (opts.unref) server.unref()
  return {
    host,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
