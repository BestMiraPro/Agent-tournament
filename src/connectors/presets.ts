import type { ConnectorKind } from './types.js'

/**
 * The read-only lock for Slack and Gmail: the exact tools the bridge may ever expose. Defined here, in code, and
 * nowhere else; no stored setting, run option or upstream annotation can add to it.
 */
export const SLACK_READ_TOOLS = ['search_messages', 'list_channels', 'read_channel', 'read_thread', 'get_user', 'list_users'] as const
export const GMAIL_READ_TOOLS = ['search_messages', 'get_message', 'get_thread', 'list_labels'] as const

/** First word of every locked tool name: what the lock's own test holds the allowlists to. */
export const READ_VERBS: readonly string[] = ['search', 'list', 'read', 'get']
export const WRITE_VERBS: readonly string[] = [
  'send', 'post', 'reply', 'react', 'schedule', 'draft', 'label', 'delete', 'remove', 'update', 'create', 'modify',
  'trash', 'archive', 'mark', 'upload', 'invite', 'write', 'edit', 'set', 'add', 'forward', 'move', 'insert', 'patch',
]

export interface ReadOnlyLock {
  lock: 'read-only'
  readAllowlist: readonly string[]
}

export function lockFor(kind: ConnectorKind | 'builtin'): ReadOnlyLock | null {
  if (kind === 'slack') return { lock: 'read-only', readAllowlist: SLACK_READ_TOOLS }
  if (kind === 'gmail') return { lock: 'read-only', readAllowlist: GMAIL_READ_TOOLS }
  return null
}

/** The official GitHub MCP server's remote endpoint. */
export const GITHUB_REMOTE_URL = 'https://api.githubcopilot.com/mcp/'
/** Its local binary, `github-mcp-server stdio`. */
export const GITHUB_LOCAL_COMMAND = 'github-mcp-server'
export const GITHUB_TOKEN_ENV = 'GITHUB_PERSONAL_ACCESS_TOKEN'

/** Gmail's only scope here: read mail and settings, nothing else. */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
