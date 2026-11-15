import { execFile } from 'node:child_process'
import { redactSecrets } from '../core/redact.js'
import { builtinConnector, type BuiltinEvidenceNote } from './builtins.js'
import { createGmailMcpServer, gmailApi } from './gmail/server.js'
import { googleAccessTokens, refreshGoogleToken } from './gmail/oauth.js'
import { NeedsSignInError, StoredMcpOAuthProvider } from './mcp-oauth.js'
import { GITHUB_TOKEN_ENV } from './presets.js'
import { createSlackMcpServer, slackApi } from './slack/server.js'
import type { ConnectorStore } from './store.js'
import type { ConnectorKind, ConnectorRecord, ConnectorSecrets, ToolPolicy } from './types.js'
import { connectHttp, connectInProcess, connectStdio, expandEnvRefs, type Upstream } from './upstream.js'

/** What a run needs from one connector: its policy inputs and how to open its upstream. */
export interface ResolvedConnector {
  id: string
  title: string
  kind: ConnectorKind | 'builtin'
  policy: ToolPolicy
  /** Built-ins get one server per agent; everything else is opened once per run and shared. */
  perAgent: boolean
  open: (ctx: { runId: string; agentId: string; note: (note: BuiltinEvidenceNote) => void }) => Promise<Upstream>
}

export interface ConnectorResolver {
  /** The store holding credentials, which no run folder may overlap; null without one. */
  storeDir: string | null
  resolve(id: string): ResolvedConnector | null
}

export interface OpenDeps {
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  /** `gh auth token`, read on the host each time a GitHub connector set to use it is opened. */
  ghToken?: () => Promise<string>
}

/** Runs `gh auth token` with a bound; the token is returned, never logged. */
export function ghAuthToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', ['auth', 'token'], { timeout: 10_000 }, (err, stdout) => {
      const token = String(stdout ?? '').trim()
      if (err || token.length === 0) reject(new Error('`gh auth token` returned no token; run `gh auth login`, or paste a token instead'))
      else resolve(token)
    })
  })
}

async function tokenFor(record: ConnectorRecord, secrets: ConnectorSecrets, deps: OpenDeps): Promise<string | null> {
  if (record.auth.type !== 'token') return null
  if (record.auth.source === 'gh-cli') return (deps.ghToken ?? ghAuthToken)()
  if (!secrets.token) throw new Error(`${record.title} has no token yet: add one on the Connectors page`)
  return secrets.token
}

/**
 * Opens a stored connector's upstream on the host, with its credentials. Shared by runs and by the dashboard's
 * connection test. GitHub is asked for read-only mode whenever the connector permits no write tool, so its own
 * server refuses writes too.
 */
export async function openStoredUpstream(
  store: ConnectorStore,
  record: ConnectorRecord,
  deps: OpenDeps = {},
): Promise<Upstream> {
  const env = deps.env ?? process.env
  const secrets = store.secrets(record.id)
  const t = record.transport
  const readOnlyGitHub = record.kind === 'github' && record.policy.writeTools.length === 0

  if (t.type === 'slack') {
    const token = await tokenFor(record, secrets, deps)
    if (!token) throw new Error(`${record.title} has no token yet: add one on the Connectors page`)
    return connectInProcess(createSlackMcpServer({ call: slackApi({ token: () => token, ...(deps.fetch ? { fetch: deps.fetch } : {}) }) }))
  }
  if (t.type === 'gmail') {
    const g = secrets.google
    if (!g?.clientId || !g.clientSecret) throw new Error(`${record.title} needs its Google OAuth client ID and secret`)
    if (!g.refreshToken) throw new NeedsSignInError(record.title)
    const accessToken = googleAccessTokens(() => refreshGoogleToken({
      clientId: g.clientId, clientSecret: g.clientSecret, refreshToken: g.refreshToken!, ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }))
    return connectInProcess(createGmailMcpServer({ get: gmailApi({ accessToken, ...(deps.fetch ? { fetch: deps.fetch } : {}) }) }))
  }
  if (t.type === 'stdio') {
    const childEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(t.env)) childEnv[k] = expandEnvRefs(v, env)
    for (const name of t.secretEnv) {
      const value = secrets.env?.[name]
      if (value !== undefined) childEnv[name] = value
    }
    const token = await tokenFor(record, secrets, deps)
    const tokenEnv = record.kind === 'github' ? GITHUB_TOKEN_ENV : record.auth.type === 'token' ? record.auth.env : undefined
    if (token && tokenEnv) childEnv[tokenEnv] = token
    if (readOnlyGitHub) childEnv.GITHUB_READ_ONLY = '1'
    // Secret arguments first (placeholders the import put there), then the host environment.
    const argEnv = { ...env, ...(secrets.args ?? {}) }
    return connectStdio({ command: expandEnvRefs(t.command, env), args: t.args.map((a) => expandEnvRefs(a, argEnv)), env: childEnv })
  }
  const url = t.url ?? secrets.url
  if (!url) throw new Error(`${record.title} has no URL`)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(t.headers)) headers[k] = expandEnvRefs(v, env)
  for (const name of t.secretHeaders) {
    const value = secrets.headers?.[name]
    if (value !== undefined) headers[name] = value
  }
  const token = await tokenFor(record, secrets, deps)
  if (token) headers.Authorization = `Bearer ${token}`
  if (readOnlyGitHub) headers['X-MCP-Readonly'] = 'true'
  return connectHttp({
    url: expandEnvRefs(url, env),
    headers,
    ...(record.auth.type === 'oauth-mcp' ? { authProvider: new StoredMcpOAuthProvider(store, record.id, { title: record.title }) } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  })
}

/**
 * A failure opening an upstream, safe to show and store: credential-shaped text is redacted, length is bounded, and
 * a needed sign-in says how to do it.
 */
export function describeOpenFailure(title: string, e: unknown): string {
  if (e instanceof NeedsSignInError) return e.message
  if ((e as Error)?.name === 'UnauthorizedError') return `${title} refused the credentials: reconnect it on the Connectors page.`
  const message = redactSecrets(e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200)
  return `${title} could not connect: ${message}`
}

/** The dashboard's resolver: built-ins first (their ids are reserved), then the store. */
export function connectorResolver(store: ConnectorStore | null, deps: OpenDeps = {}): ConnectorResolver {
  return {
    storeDir: store?.dir ?? null,
    resolve(id) {
      const builtin = builtinConnector(id)
      if (builtin) {
        return {
          id, title: builtin.title, kind: 'builtin', policy: { disabledTools: [], writeTools: [] }, perAgent: true,
          open: (ctx) => connectInProcess(builtin.createServer({ runId: ctx.runId, agentId: ctx.agentId, connectorId: id, evidence: ctx.note })),
        }
      }
      const record = store?.get(id) ?? null
      if (!record || !store) return null
      return {
        id, title: record.title, kind: record.kind, policy: record.policy, perAgent: false,
        open: () => openStoredUpstream(store, record, deps),
      }
    },
  }
}
