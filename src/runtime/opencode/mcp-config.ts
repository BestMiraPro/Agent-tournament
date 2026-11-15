import type { McpEndpoint } from '../../connectors/bridge.js'
import { CONNECTOR_ID } from '../../connectors/types.js'

/** Where the runner writes it: OpenCode loads `.opencode/opencode.json` from the session directory. */
export const PROJECT_CONFIG_FILE = '.opencode/opencode.json'

/** Above the tool bridge's own 60 s per-call limit, so the bridge's answer arrives before OpenCode gives up. */
export const OPENCODE_MCP_TIMEOUT_MS = 70_000

/**
 * The per-agent OpenCode config that gives an agent its run's connectors: each one a remote MCP server at the host
 * tool bridge, authenticated by the agent's own bridge token. OAuth discovery is off; the bridge token is the only
 * credential in it, so it is safe in the agent's workspace.
 *
 * Shape verified against opencode 1.18.21 (`packages/core/src/v1/config/mcp.ts`): `type: "remote"`, `url`,
 * `enabled`, `headers`, `oauth: false`, `timeout`. Instance config merges `.opencode/opencode.json` after
 * `OPENCODE_CONFIG`, so a protected shard keeps its relay provider settings.
 */
export function opencodeMcpConfig(endpoints: readonly McpEndpoint[]): string {
  const mcp: Record<string, unknown> = {}
  for (const e of endpoints) {
    if (!CONNECTOR_ID.test(e.id)) throw new Error(`connector id ${JSON.stringify(e.id)} is not a plain connector id`)
    let url: URL
    try {
      url = new URL(e.url)
    } catch {
      throw new Error(`connector URL must be an http URL, got ${JSON.stringify(e.url)}`)
    }
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== `/mcp/${e.id}`) {
      throw new Error(`connector URL must look like http://host:port/mcp/${e.id}, got ${JSON.stringify(e.url)}`)
    }
    mcp[e.id] = { type: 'remote', url: e.url, enabled: true, oauth: false, headers: { ...e.headers }, timeout: OPENCODE_MCP_TIMEOUT_MS }
  }
  return `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp }, null, 2)}\n`
}
