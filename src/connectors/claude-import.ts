import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertConnectorId, CONNECTOR_ID, RESERVED_CONNECTOR_IDS, type ConnectorRecord, type ConnectorSecrets } from './types.js'

/**
 * Finds the MCP servers configured for Claude Code on this machine, read-only: these files are never written.
 *
 * - `~/.claude.json`: `mcpServers` (user scope) and `projects[<path>].mcpServers` (local scope);
 * - `~/.claude/settings.json`: `mcpServers`, when present;
 * - each known project's `.mcp.json` (project scope), and the app's own folder's;
 * - plugin `.mcp.json` files under `~/.claude/plugins` (a bounded walk).
 *
 * claude.ai-hosted connectors (Gmail, Slack, GitHub, Drive …) are not in any of these: their OAuth tokens belong to
 * claude.ai and cannot be imported. The presets replace them.
 */

export type DiscoverySource = 'user' | 'local' | 'project' | 'settings' | 'plugin'

export type DiscoveredTransport =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string> }

export interface DiscoveredServer {
  /** Stable across discoveries: source, file and name. */
  key: string
  name: string
  source: DiscoverySource
  sourcePath: string
  transport: DiscoveredTransport
}

const MAX_CONFIG_BYTES = 32 * 1024 * 1024
const MAX_PLUGIN_DEPTH = 7
const MAX_PLUGIN_DIRS = 5000

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_CONFIG_BYTES) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const strings = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val
  }
  return out
}

function parseEntry(raw: unknown, pluginRoot: string | null): DiscoveredTransport | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const expand = (s: string) => (pluginRoot ? s.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot) : s)
  const type = typeof e.type === 'string' ? e.type : undefined
  if ((type === 'http' || type === 'sse' || (type === undefined && typeof e.url === 'string')) && typeof e.url === 'string') {
    const headers = strings(e.headers)
    for (const k of Object.keys(headers)) headers[k] = expand(headers[k]!)
    return { type: 'http', url: expand(e.url), headers }
  }
  if ((type === undefined || type === 'stdio') && typeof e.command === 'string' && e.command.length > 0) {
    const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string').map(expand) : []
    const env = strings(e.env)
    for (const k of Object.keys(env)) env[k] = expand(env[k]!)
    return { type: 'stdio', command: expand(e.command), args, env }
  }
  return null
}

function serversOf(container: unknown): [string, unknown][] {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return []
  return Object.entries(container as Record<string, unknown>)
}

function pluginMcpFiles(root: string): string[] {
  const found: string[] = []
  let visited = 0
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_PLUGIN_DEPTH || visited >= MAX_PLUGIN_DIRS) return
    visited++
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === '.mcp.json') found.push(join(dir, entry.name))
      else if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== 'node_modules' && entry.name !== '.git') walk(join(dir, entry.name), depth + 1)
    }
  }
  if (existsSync(root)) walk(root, 0)
  return found.sort()
}

export function discoverClaudeCodeServers(opts: { home: string; cwd?: string }): DiscoveredServer[] {
  const out: DiscoveredServer[] = []
  const add = (source: DiscoverySource, sourcePath: string, name: string, raw: unknown, pluginRoot: string | null = null) => {
    const transport = parseEntry(raw, pluginRoot)
    if (transport) out.push({ key: `${source}:${sourcePath}:${name}`, name, source, sourcePath, transport })
  }

  const claudeJsonPath = join(opts.home, '.claude.json')
  const claudeJson = readJson(claudeJsonPath)
  const projectDirs = new Set<string>(opts.cwd ? [opts.cwd] : [])
  if (claudeJson) {
    for (const [name, raw] of serversOf(claudeJson.mcpServers)) add('user', claudeJsonPath, name, raw)
    for (const [project, value] of serversOf(claudeJson.projects)) {
      projectDirs.add(project)
      for (const [name, raw] of serversOf((value as { mcpServers?: unknown } | null)?.mcpServers)) {
        add('local', `${claudeJsonPath}#${project}`, name, raw)
      }
    }
  }
  const settingsPath = join(opts.home, '.claude', 'settings.json')
  for (const [name, raw] of serversOf(readJson(settingsPath)?.mcpServers)) add('settings', settingsPath, name, raw)
  for (const dir of [...projectDirs].sort()) {
    const path = join(dir, '.mcp.json')
    for (const [name, raw] of serversOf(readJson(path)?.mcpServers)) add('project', path, name, raw)
  }
  for (const path of pluginMcpFiles(join(opts.home, '.claude', 'plugins'))) {
    const json = readJson(path)
    if (!json) continue
    // A plugin's file is either `{ "mcpServers": {...} }` or the servers themselves.
    const container = json.mcpServers && typeof json.mcpServers === 'object' ? json.mcpServers : json
    for (const [name, raw] of serversOf(container)) add('plugin', path, name, raw, dirname(path))
  }
  return out
}

const SECRET_WORDS = new Set([
  'token', 'tokens', 'secret', 'secrets', 'key', 'apikey', 'password', 'passwd', 'pass', 'auth', 'authorization',
  'credential', 'credentials', 'cookie', 'session', 'pat', 'bearer', 'private', 'signature', 'sig',
])
const SECRET_SUBSTRINGS = ['token', 'secret', 'password', 'apikey', 'api_key', 'api-key', 'credential']
const SECRET_VALUE = /^(gh[pousr]_|github_pat_|xox[abposr]-|sk-|sk_|AIza|ya29\.|glpat-|Bearer\s|Basic\s)/

/** An environment reference, `${VAR}`, is not a secret value: it is resolved from the host when the server starts. */
const isEnvRef = (value: string) => /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/.test(value)

/** Whether a name or value looks like a credential. Defence in depth: when unsure, it goes to the secrets file. */
export function looksSecret(name: string, value: string): boolean {
  if (value.length === 0 || isEnvRef(value)) return false
  const lower = name.toLowerCase()
  if (lower.split(/[^a-z0-9]+/).some((w) => SECRET_WORDS.has(w))) return true
  if (SECRET_SUBSTRINGS.some((s) => lower.includes(s))) return true
  if (SECRET_VALUE.test(value)) return true
  return value.length >= 32 && /^[A-Za-z0-9_\-+/=.]+$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value)
}

/** A URL that carries a credential in its user info or query. */
export function urlLooksSecret(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.username || u.password) return true
    for (const [k, v] of u.searchParams) if (looksSecret(k, v)) return true
    return false
  } catch {
    return false
  }
}

const MASK = '••••'

function maskUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.username) u.username = MASK
    if (u.password) u.password = MASK
    for (const [k, v] of [...u.searchParams]) if (looksSecret(k, v)) u.searchParams.set(k, MASK)
    return u.toString()
  } catch {
    return MASK
  }
}

/** What the dashboard may show: every credential-looking value masked. */
export function maskDiscovered(server: DiscoveredServer): DiscoveredServer {
  const t = server.transport
  if (t.type === 'http') {
    return {
      ...server,
      transport: {
        type: 'http',
        url: maskUrl(t.url),
        headers: Object.fromEntries(Object.entries(t.headers).map(([k, v]) => [k, looksSecret(k, v) ? MASK : v])),
      },
    }
  }
  return {
    ...server,
    transport: {
      type: 'stdio',
      command: t.command,
      args: maskArgs(t.args).args,
      env: Object.fromEntries(Object.entries(t.env).map(([k, v]) => [k, looksSecret(k, v) ? MASK : v])),
    },
  }
}

/** Splits secret-looking arguments out: `--token x`, `--token=x`, or a value that looks like a credential. */
function maskArgs(args: readonly string[], placeholder: (i: number) => string = () => MASK): { args: string[]; secrets: Record<string, string> } {
  const out: string[] = []
  const secrets: Record<string, string> = {}
  let n = 0
  const take = (value: string) => {
    n++
    const name = placeholder(n)
    secrets[name] = value
    return name === MASK ? MASK : `\${${name}}`
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const eq = /^(--?[A-Za-z0-9_-]+)=(.*)$/.exec(arg)
    const prev = i > 0 ? args[i - 1]! : ''
    if (eq && looksSecret(eq[1]!, eq[2]!)) out.push(`${eq[1]}=${take(eq[2]!)}`)
    else if (/^--?[A-Za-z0-9_-]+$/.test(prev) && looksSecret(prev, arg)) out.push(take(arg))
    else if (!arg.startsWith('-') && looksSecret('', arg)) out.push(take(arg))
    else out.push(arg)
  }
  return { args: out, secrets }
}

/** A connector id from a server name: lowercase, hyphenated, starting with a letter, not reserved or taken. */
export function suggestConnectorId(name: string, taken: ReadonlySet<string>): string {
  let base = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28)
  if (!/^[a-z]/.test(base)) base = `mcp-${base}`.slice(0, 28)
  if (!base || base === 'mcp-') base = 'mcp'
  if (RESERVED_CONNECTOR_IDS.includes(base)) base = `${base}-mcp`
  let id = base
  for (let i = 2; taken.has(id) || !CONNECTOR_ID.test(id); i++) id = `${base}-${i}`
  return id
}

/**
 * The connector record and secrets for an imported server. Plain values stay in the record; every credential-looking
 * env value, header, URL and argument moves to the secrets file. HTTP servers without an Authorization header get MCP
 * OAuth, used only if the server asks for it.
 */
export function importedConnector(server: DiscoveredServer, id: string, now: number): { record: ConnectorRecord; secrets: ConnectorSecrets } {
  assertConnectorId(id)
  const t = server.transport
  const secrets: ConnectorSecrets = {}
  const base = {
    id,
    title: server.name,
    kind: 'custom' as const,
    origin: { type: 'imported' as const, source: `${server.source}:${server.sourcePath}`, name: server.name },
    policy: { disabledTools: [], writeTools: [] },
    tools: null,
    toolsCheckedAt: null,
    createdAt: now,
  }
  if (t.type === 'stdio') {
    const env: Record<string, string> = {}
    const secretEnv: string[] = []
    for (const [k, v] of Object.entries(t.env)) {
      if (looksSecret(k, v)) {
        secretEnv.push(k)
        secrets.env = { ...secrets.env, [k]: v }
      } else env[k] = v
    }
    const split = maskArgs(t.args, (i) => `ARENA_SECRET_ARG_${i}`)
    if (Object.keys(split.secrets).length > 0) secrets.args = split.secrets
    return { record: { ...base, transport: { type: 'stdio', command: t.command, args: split.args, env, secretEnv }, auth: { type: 'none' } }, secrets }
  }
  const headers: Record<string, string> = {}
  const secretHeaders: string[] = []
  for (const [k, v] of Object.entries(t.headers)) {
    if (looksSecret(k, v)) {
      secretHeaders.push(k)
      secrets.headers = { ...secrets.headers, [k]: v }
    } else headers[k] = v
  }
  const urlSecret = urlLooksSecret(t.url)
  if (urlSecret) secrets.url = t.url
  const hasAuthHeader = [...Object.keys(headers), ...secretHeaders].some((h) => h.toLowerCase() === 'authorization')
  return {
    record: {
      ...base,
      transport: { type: 'http', url: urlSecret ? null : t.url, headers, secretHeaders },
      auth: hasAuthHeader ? { type: 'none' } : { type: 'oauth-mcp' },
    },
    secrets,
  }
}

/** The file a server came from, for display. */
export const sourceLabel = (s: DiscoveredServer) => `${s.source} — ${basename(s.sourcePath.split('#')[0]!)}${s.sourcePath.includes('#') ? ` (${s.sourcePath.split('#')[1]})` : ''}`
