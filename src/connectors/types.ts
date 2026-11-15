/**
 * What a connector is, as the host stores it. A connector gives tournament agents one MCP server's tools through the
 * host tool bridge; its credentials stay in the host's secrets file and never reach a worker.
 */

/** Also the OpenCode MCP server key, so a connector's tools are named `<id>_<tool>`. */
export const CONNECTOR_ID = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Ids whose `<id>_` prefixes an OpenCode built-in permission or tool (`external_directory`, `doom_loop`,
 * `apply_patch`). A connector's profile rule is `"<id>_*": allow`, so these would widen a built-in.
 */
export const RESERVED_CONNECTOR_IDS: readonly string[] = ['external', 'doom', 'apply']

export function assertConnectorId(id: string): void {
  if (!CONNECTOR_ID.test(id)) {
    throw new Error(`connector id must be 1-32 lowercase letters, digits or hyphens, starting with a letter, got ${JSON.stringify(id)}`)
  }
  if (RESERVED_CONNECTOR_IDS.includes(id)) {
    throw new Error(`connector id "${id}" is reserved: its tools would match a built-in OpenCode permission`)
  }
}

export type ConnectorKind = 'github' | 'slack' | 'gmail' | 'custom'

export type ConnectorTransport =
  | {
      type: 'stdio'
      command: string
      args: string[]
      /** Plain values. `${VAR}` references are expanded from the host environment when the server starts. */
      env: Record<string, string>
      /** Names whose values live in the secrets file. */
      secretEnv: string[]
    }
  | {
      type: 'http'
      /** Null when the URL itself carries a credential and lives in the secrets file. */
      url: string | null
      headers: Record<string, string>
      secretHeaders: string[]
    }
  /** The in-house read-only servers. */
  | { type: 'slack' }
  | { type: 'gmail' }

export type ConnectorAuth =
  | { type: 'none' }
  /**
   * A static token: sent as `Authorization: Bearer` to an HTTP server, or in `env` to a stdio one. `gh-cli` reads
   * `gh auth token` each time the server is opened and never stores it.
   */
  | { type: 'token'; source: 'manual' | 'gh-cli'; env?: string }
  | { type: 'oauth-google' }
  | { type: 'oauth-mcp' }

export interface ToolPolicy {
  /** Read tools the operator switched off. */
  disabledTools: string[]
  /** Write tools the operator permits runs to opt into. Always empty for a locked connector. */
  writeTools: string[]
}

export interface ToolSnapshot {
  name: string
  description: string
  readOnlyHint: boolean | null
}

export type ConnectorOrigin =
  | { type: 'preset' }
  | { type: 'custom' }
  | { type: 'imported'; source: string; name: string }

export interface ConnectorRecord {
  id: string
  title: string
  kind: ConnectorKind
  origin: ConnectorOrigin
  transport: ConnectorTransport
  auth: ConnectorAuth
  policy: ToolPolicy
  /** What the last connection test listed; null before any. */
  tools: ToolSnapshot[] | null
  toolsCheckedAt: number | null
  createdAt: number
}

/** Credential material, kept only in the secrets file. */
export interface ConnectorSecrets {
  token?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  url?: string
  google?: { clientId: string; clientSecret: string; refreshToken?: string; scope?: string }
  mcpOauth?: {
    clientInformation?: Record<string, unknown>
    tokens?: Record<string, unknown>
    codeVerifier?: string
    discovery?: Record<string, unknown>
  }
}
