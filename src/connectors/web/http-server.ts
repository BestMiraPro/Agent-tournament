import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { WebEvidenceSink } from './evidence.js'
import { webConnector } from './mcp-server.js'

/**
 * The web tools for local-run workers: an MCP endpoint on the host's loopback, in this process, so
 * keys, limits and evidence never leave it — the provider relay's discipline.
 *
 * Each run holds a grant: a random secret, revoked when the run stops. An agent's bearer token is
 * `<grant>.<agentId>.<HMAC(secret, agentId)>`, so calls are attributed without per-agent state and
 * one agent cannot mint another's token without the secret. Stateless Streamable HTTP: `POST /mcp`
 * only, a fresh server per request, the Host header pinned to the loopback address.
 */

export interface RunWebGrant {
  /** The bearer token one agent of this run presents. */
  tokenFor(agentId: string): string
  /** Starts serving the run: its live id, and where its call records go. */
  attach(runId: string, evidence: WebEvidenceSink): void
  /** From now on the run's tokens are refused and its open servers refuse calls. */
  revoke(): void
}

interface GrantState {
  secret: Buffer
  runId: string | null
  evidence: WebEvidenceSink | null
}

const MAX_BODY_BYTES = 64 * 1024
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/

const macFor = (secret: Buffer, agentId: string) => createHmac('sha256', secret).update(agentId).digest('base64url')

const sendJson = (res: ServerResponse, status: number, error: string, extra: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...extra })
  res.end(JSON.stringify({ error }))
}

export class WebToolHost {
  private grants = new Map<string, GrantState>()
  /** Set once listening: the only Host header accepted. */
  hostHeader: string | null = null

  constructor(private readonly connector = webConnector()) {}

  grant(): RunWebGrant {
    const grantId = randomBytes(12).toString('hex')
    const state: GrantState = { secret: randomBytes(32), runId: null, evidence: null }
    this.grants.set(grantId, state)
    return {
      tokenFor: (agentId) => {
        if (!AGENT_ID.test(agentId)) throw new Error(`unsafe agent id for a web tool token: ${agentId}`)
        return `${grantId}.${agentId}.${macFor(state.secret, agentId)}`
      },
      attach: (runId, evidence) => {
        state.runId = runId
        state.evidence = evidence
      },
      revoke: () => {
        this.grants.delete(grantId)
        if (state.runId) this.connector.endRun(state.runId)
      },
    }
  }

  private authorize(header: string | undefined): { runId: string; agentId: string; evidence: WebEvidenceSink } | null {
    const token = /^Bearer (\S+)$/.exec(header ?? '')?.[1]
    const parts = token?.split('.')
    if (!parts || parts.length !== 3) return null
    const [grantId, agentId, mac] = parts as [string, string, string]
    const state = this.grants.get(grantId)
    if (!state || !state.runId || !state.evidence || !AGENT_ID.test(agentId)) return null
    const expected = Buffer.from(macFor(state.secret, agentId))
    const given = Buffer.from(mac)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
    return { runId: state.runId, agentId, evidence: state.evidence }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url !== '/mcp') return sendJson(res, 404, 'not found')
    if (req.method !== 'POST') return sendJson(res, 405, 'only POST is served', { allow: 'POST' })
    if (!this.hostHeader || req.headers.host !== this.hostHeader) return sendJson(res, 403, 'unexpected host')
    const caller = this.authorize(req.headers.authorization)
    if (!caller) return sendJson(res, 401, 'missing or unknown web tool token')

    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY_BYTES) return sendJson(res, 413, `request body exceeds ${MAX_BODY_BYTES} bytes`)
      chunks.push(chunk as Buffer)
    }
    let body: unknown
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return sendJson(res, 400, 'request body is not JSON')
    }

    const server = this.connector.createServer(caller)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }
}

export interface WebToolHostHandle {
  host: WebToolHost
  /** The endpoint agents are configured with. */
  url: string
  close(): Promise<void>
}

export async function startWebToolHost(opts: {
  connector?: ReturnType<typeof webConnector>
  host?: string
  port?: number
  /** Do not keep the process alive for this server alone. */
  unref?: boolean
} = {}): Promise<WebToolHostHandle> {
  const address = opts.host ?? '127.0.0.1'
  const host = new WebToolHost(opts.connector)
  const server = createServer((req, res) => {
    host.handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, 'internal error')
      else res.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, address, () => resolve())
  })
  if (opts.unref) server.unref()
  const port = (server.address() as AddressInfo).port
  host.hostHeader = `${address}:${port}`
  return {
    host,
    url: `http://${address}:${port}/mcp`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

let shared: Promise<WebToolHostHandle> | null = null

/**
 * The one web tool host in this process, started on first use and shared by every local run, each
 * with its own grant. Loopback only; never keeps the process alive; a failed start is retried.
 */
export function processWebTools(): Promise<WebToolHostHandle> {
  if (!shared) {
    const starting = startWebToolHost({ unref: true })
    shared = starting
    starting.catch(() => {
      if (shared === starting) shared = null
    })
  }
  return shared
}
