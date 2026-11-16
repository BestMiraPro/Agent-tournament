import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { assertConnectorId } from './types.js'

/** Extra evidence a built-in records about a call, for example a URL it fetched. Bounded and redacted on the way in. */
export interface BuiltinEvidenceNote {
  summary: string
  detail?: string
  kind?: 'tool' | 'network'
}

/** What a built-in server is created with: one server per run and agent. */
export interface BuiltinConnectorContext {
  runId: string
  agentId: string
  connectorId: string
  /** Records a note under this agent's evidence for the round. Never throws. */
  evidence: (note: BuiltinEvidenceNote) => void
}

/**
 * An in-process MCP server the app provides itself (web search, for one). The bridge hosts it like any connector: the
 * same per-agent tokens, limits and evidence. `readOnly: true` is the only kind: every tool counts as read, and there
 * is nothing for a run to opt into.
 */
export interface BuiltinConnector {
  id: string
  title: string
  readOnly: true
  description?: string
  createServer: (ctx: BuiltinConnectorContext) => McpServer | Server
}

const registered = new Map<string, BuiltinConnector>()

/** Registers a built-in at startup. Its id follows the connector id rules and must be unique. */
export function registerBuiltinConnector(connector: BuiltinConnector): void {
  assertConnectorId(connector.id)
  if (connector.readOnly !== true) throw new Error(`built-in connector ${connector.id} must be read-only`)
  if (registered.has(connector.id)) throw new Error(`a built-in connector named "${connector.id}" is already registered`)
  registered.set(connector.id, connector)
}

export function builtinConnector(id: string): BuiltinConnector | null {
  return registered.get(id) ?? null
}

export function builtinConnectors(): BuiltinConnector[] {
  return [...registered.values()]
}

/** Tests only: forgets a registration. */
export function unregisterBuiltinConnector(id: string): void {
  registered.delete(id)
}
