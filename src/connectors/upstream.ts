import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { UpstreamTool } from './policy.js'

/** One MCP server as the bridge uses it: list tools, call one, close. */
export interface Upstream {
  listTools(): Promise<UpstreamTool[]>
  callTool(name: string, args: Record<string, unknown>, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<CallToolResult>
  close(): Promise<void>
}

const CLIENT_INFO = { name: 'agent-tournament-tool-bridge', version: '1.0.0' }
const MAX_TOOL_PAGES = 20
const CONNECT_TIMEOUT_MS = 30_000

function wrap(client: Client, extraClose?: () => Promise<void>): Upstream {
  let closed = false
  return {
    async listTools() {
      const tools: UpstreamTool[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS })
        tools.push(...(res.tools as UpstreamTool[]))
        cursor = res.nextCursor
        if (!cursor) break
      }
      return tools
    },
    async callTool(name, args, opts) {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: opts.timeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
      // The legacy `toolResult` shape is folded into ordinary content.
      if ('toolResult' in result && !('content' in result)) {
        return { content: [{ type: 'text', text: JSON.stringify(result.toolResult) }] }
      }
      return result as CallToolResult
    },
    async close() {
      if (closed) return
      closed = true
      await client.close().catch(() => {})
      await extraClose?.().catch(() => {})
    },
  }
}

async function connectClient(transport: Transport): Promise<Client> {
  const client = new Client(CLIENT_INFO)
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
  return client
}

/** An in-process server (Slack, Gmail, a built-in) behind the SDK's in-memory transport. */
export async function connectInProcess(server: McpServer | Server): Promise<Upstream> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = await connectClient(clientSide)
  return wrap(client, () => server.close())
}

/**
 * A local server the host starts. Its environment is the SDK's minimal default (PATH, HOME, USER …) plus what the
 * connector sets: never the app's own environment, which may hold unrelated credentials. stderr is discarded so a
 * server cannot print its credentials into the app's log.
 */
export async function connectStdio(spec: { command: string; args: string[]; env: Record<string, string>; cwd?: string }): Promise<Upstream> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...getDefaultEnvironment(), ...spec.env },
    stderr: 'ignore',
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
  })
  return wrap(await connectClient(transport))
}

/**
 * A remote server: Streamable HTTP first, then the older SSE transport, as OpenCode and Claude Code do. Redirects are
 * not followed, so credentials in headers never travel to a host the connector does not name.
 */
export async function connectHttp(spec: {
  url: string
  headers: Record<string, string>
  authProvider?: OAuthClientProvider
  fetch?: typeof fetch
}): Promise<Upstream> {
  const url = new URL(spec.url)
  const requestInit: RequestInit = { headers: spec.headers, redirect: 'error' }
  const common = { requestInit, ...(spec.authProvider ? { authProvider: spec.authProvider } : {}), ...(spec.fetch ? { fetch: spec.fetch } : {}) }
  try {
    return wrap(await connectClient(new StreamableHTTPClientTransport(url, common)))
  } catch (first) {
    // An auth failure is the answer, not a reason to try another transport.
    if ((first as Error)?.name === 'UnauthorizedError') throw first
    try {
      return wrap(await connectClient(new SSEClientTransport(url, common)))
    } catch {
      throw first
    }
  }
}

/** Expands `${VAR}` and `${VAR:-default}` from the host environment, as Claude Code does for its MCP configs. */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) => env[name] ?? fallback ?? '')
}
