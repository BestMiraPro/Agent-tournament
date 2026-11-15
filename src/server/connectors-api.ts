import type { FastifyInstance, FastifyReply } from 'fastify'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { z } from 'zod'
import { builtinConnector, builtinConnectors } from '../connectors/builtins.js'
import { discoverClaudeCodeServers, importedConnector, looksSecret, maskDiscovered, sourceLabel, suggestConnectorId } from '../connectors/claude-import.js'
import { exchangeGoogleCode, googleAuthUrl } from '../connectors/gmail/oauth.js'
import { NeedsSignInError, StoredMcpOAuthProvider } from '../connectors/mcp-oauth.js'
import { loopbackCallbackUrl, oauthState, pkcePair } from '../connectors/oauth.js'
import { classifyTool, policySubjectFor, type UpstreamTool } from '../connectors/policy.js'
import { GITHUB_LOCAL_COMMAND, GITHUB_REMOTE_URL, lockFor } from '../connectors/presets.js'
import { describeOpenFailure, openStoredUpstream, type OpenDeps } from '../connectors/resolve.js'
import { newConnectorRecord, type ConnectorStore } from '../connectors/store.js'
import { assertConnectorId, type ConnectorRecord, type ConnectorSecrets, type ToolSnapshot } from '../connectors/types.js'
import { connectInProcess, type Upstream } from '../connectors/upstream.js'

export interface ConnectorRouteDeps extends OpenDeps {
  /** Null when the dashboard runs without a store: built-ins are listed, nothing can be added. */
  store: ConnectorStore | null
  /** Where Claude Code's files are looked for. */
  home: string
  cwd: string
  /** Seam for tests: how a stored connector's upstream is opened. */
  open?: (store: ConnectorStore, record: ConnectorRecord) => Promise<Upstream>
  now?: () => number
}

export const OAUTH_CALLBACK_PATH = '/api/connectors/oauth/callback'
const FLOW_TTL_MS = 10 * 60_000

interface PendingFlow {
  connectorId: string
  kind: 'gmail' | 'mcp'
  redirectUri: string
  verifier?: string
  expiresAt: number
}

/** What the dashboard may know about a connector: everything but credential values. */
export function connectorView(store: ConnectorStore, record: ConnectorRecord) {
  const secrets = store.secrets(record.id)
  const t = record.transport
  const lock = lockFor(record.kind)
  const subject = policySubjectFor({ kind: record.kind, policy: record.policy })
  return {
    id: record.id,
    title: record.title,
    kind: record.kind,
    builtin: false,
    origin: record.origin,
    transport: t.type === 'stdio'
      ? { type: 'stdio', command: t.command, args: t.args, envNames: Object.keys(t.env), secretEnvNames: t.secretEnv }
      : t.type === 'http'
        ? { type: 'http', url: t.url ?? '(stored with the credentials)', headerNames: Object.keys(t.headers), secretHeaderNames: t.secretHeaders }
        : { type: t.type },
    auth: record.auth,
    secretsSet: store.secretNames(record.id),
    connected: isConnected(record, secrets),
    locked: lock !== null,
    readAllowlist: lock ? [...lock.readAllowlist] : null,
    policy: record.policy,
    tools: record.tools?.map((tool) => ({ ...tool, classification: classifyTool(subject, { name: tool.name, annotations: tool.readOnlyHint === null ? {} : { readOnlyHint: tool.readOnlyHint } }) })) ?? null,
    toolsCheckedAt: record.toolsCheckedAt,
  }
}

function isConnected(record: ConnectorRecord, secrets: ConnectorSecrets): boolean {
  if (record.kind === 'gmail') return Boolean(secrets.google?.refreshToken)
  if (record.auth.type === 'token') return record.auth.source === 'gh-cli' || Boolean(secrets.token)
  if (record.auth.type === 'oauth-mcp') return Boolean(secrets.mcpOauth?.tokens) || record.toolsCheckedAt !== null
  return true
}

const idSchema = z.string().min(1).max(32)
const nonEmpty = z.string().trim().min(1)
const addSchema = z.discriminatedUnion('preset', [
  z.object({
    preset: z.literal('github'), id: idSchema.optional(), title: z.string().optional(),
    mode: z.enum(['remote', 'local']).default('remote'), url: z.string().url().optional(), command: nonEmpty.optional(),
    tokenSource: z.enum(['manual', 'gh-cli']).default('manual'), token: nonEmpty.optional(),
  }),
  z.object({ preset: z.literal('slack'), id: idSchema.optional(), title: z.string().optional(), token: nonEmpty }),
  z.object({ preset: z.literal('gmail'), id: idSchema.optional(), title: z.string().optional(), clientId: nonEmpty, clientSecret: nonEmpty }),
  z.object({
    preset: z.literal('remote'), id: idSchema, title: z.string().optional(), url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}), bearerToken: nonEmpty.optional(),
  }),
  z.object({
    preset: z.literal('local'), id: idSchema, title: z.string().optional(), command: nonEmpty,
    args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}),
  }),
])
const patchSchema = z.object({
  title: z.string().trim().min(1).optional(),
  policy: z.object({ disabledTools: z.array(z.string()).max(500).optional(), writeTools: z.array(z.string()).max(500).optional() }).optional(),
  token: nonEmpty.optional(),
  clientId: nonEmpty.optional(),
  clientSecret: nonEmpty.optional(),
})

const errorOf = (e: unknown) => (e instanceof z.ZodError ? e.issues[0]?.message ?? 'invalid request body' : e instanceof Error ? e.message : String(e))

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function page(reply: FastifyReply, status: number, title: string, message: string) {
  return reply.code(status).type('text/html; charset=utf-8').send(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.5"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`,
  )
}

/** The record and secrets a preset form creates. Every value the operator types that is a credential goes to secrets. */
function fromPreset(body: z.infer<typeof addSchema>, taken: ReadonlySet<string>, now: number): { record: ConnectorRecord; secrets: ConnectorSecrets } {
  const id = body.id ?? suggestConnectorId(body.preset, taken)
  assertConnectorId(id)
  if (builtinConnector(id)) throw new Error(`"${id}" is a built-in connector's id`)
  if (taken.has(id)) throw new Error(`a connector named "${id}" already exists`)
  switch (body.preset) {
    case 'github': {
      if (body.tokenSource === 'manual' && !body.token) throw new Error('paste a GitHub token, or choose to use `gh auth token`')
      const transport = body.mode === 'local'
        ? { type: 'stdio' as const, command: body.command ?? GITHUB_LOCAL_COMMAND, args: ['stdio'], env: {}, secretEnv: [] }
        : { type: 'http' as const, url: body.url ?? GITHUB_REMOTE_URL, headers: {}, secretHeaders: [] }
      return {
        record: newConnectorRecord({ id, title: body.title || 'GitHub', kind: 'github', transport, auth: { type: 'token', source: body.tokenSource } }, now),
        secrets: body.tokenSource === 'manual' ? { token: body.token! } : {},
      }
    }
    case 'slack':
      return {
        record: newConnectorRecord({ id, title: body.title || 'Slack', kind: 'slack', transport: { type: 'slack' }, auth: { type: 'token', source: 'manual' } }, now),
        secrets: { token: body.token },
      }
    case 'gmail':
      return {
        record: newConnectorRecord({ id, title: body.title || 'Gmail', kind: 'gmail', transport: { type: 'gmail' }, auth: { type: 'oauth-google' } }, now),
        secrets: { google: { clientId: body.clientId, clientSecret: body.clientSecret } },
      }
    case 'remote': {
      const headers: Record<string, string> = {}
      const secretHeaders: string[] = []
      const secret: Record<string, string> = {}
      for (const [k, v] of Object.entries(body.headers)) {
        if (looksSecret(k, v)) { secretHeaders.push(k); secret[k] = v } else headers[k] = v
      }
      return {
        record: newConnectorRecord({
          id, title: body.title || id, kind: 'custom', transport: { type: 'http', url: body.url, headers, secretHeaders },
          auth: body.bearerToken ? { type: 'token', source: 'manual' } : { type: 'oauth-mcp' },
        }, now),
        secrets: { ...(body.bearerToken ? { token: body.bearerToken } : {}), ...(secretHeaders.length > 0 ? { headers: secret } : {}) },
      }
    }
    case 'local': {
      const env: Record<string, string> = {}
      const secretEnv: string[] = []
      const secret: Record<string, string> = {}
      for (const [k, v] of Object.entries(body.env)) {
        if (looksSecret(k, v)) { secretEnv.push(k); secret[k] = v } else env[k] = v
      }
      return {
        record: newConnectorRecord({
          id, title: body.title || id, kind: 'custom', transport: { type: 'stdio', command: body.command, args: body.args, env, secretEnv }, auth: { type: 'none' },
        }, now),
        secrets: secretEnv.length > 0 ? { env: secret } : {},
      }
    }
  }
}

function snapshot(tools: UpstreamTool[]): ToolSnapshot[] {
  return tools.map((t) => ({
    name: t.name,
    description: (t.description ?? '').slice(0, 500),
    readOnlyHint: typeof t.annotations?.readOnlyHint === 'boolean' ? t.annotations.readOnlyHint : null,
  }))
}

/**
 * The Connectors page's API. No route ever returns a credential value: views say which secrets are set, never what
 * they are. OAuth sign-ins start here and come back to `OAUTH_CALLBACK_PATH` on the dashboard's own origin.
 */
export function registerConnectorRoutes(app: FastifyInstance, deps: ConnectorRouteDeps): void {
  const now = deps.now ?? Date.now
  const open = deps.open ?? ((store: ConnectorStore, record: ConnectorRecord) => openStoredUpstream(store, record, deps))
  const flows = new Map<string, PendingFlow>()
  const storeOr409 = (reply: FastifyReply): ConnectorStore | null => {
    if (!deps.store) {
      void reply.code(409).send({ error: 'This dashboard was started without a connector store (--connectors-dir).' })
      return null
    }
    return deps.store
  }
  const sweepFlows = () => {
    for (const [state, flow] of flows) if (flow.expiresAt < now()) flows.delete(state)
  }

  app.get('/api/connectors', async () => ({
    store: deps.store !== null,
    connectors: deps.store ? deps.store.list().map((r) => connectorView(deps.store!, r)) : [],
    builtins: builtinConnectors().map((b) => ({ id: b.id, title: b.title, description: b.description ?? '', builtin: true, readOnly: true })),
  }))

  app.post('/api/connectors', async (req, reply) => {
    const store = storeOr409(reply)
    if (!store) return reply
    let created
    try {
      const body = addSchema.parse(req.body ?? {})
      const { record, secrets } = fromPreset(body, new Set(store.list().map((c) => c.id)), now())
      created = store.create(record, secrets)
    } catch (e) {
      return reply.code(400).send({ error: errorOf(e) })
    }
    return reply.code(201).send({ connector: connectorView(store, created) })
  })

  app.patch('/api/connectors/:id', async (req, reply) => {
    const store = storeOr409(reply)
    if (!store) return reply
    const { id } = req.params as { id: string }
    const current = store.get(id)
    if (!current) return reply.code(404).send({ error: 'no such connector' })
    try {
      const body = patchSchema.parse(req.body ?? {})
      const updated = store.update(id, (r) => ({
        ...r,
        title: body.title ?? r.title,
        policy: {
          disabledTools: body.policy?.disabledTools ?? r.policy.disabledTools,
          writeTools: body.policy?.writeTools ?? r.policy.writeTools,
        },
      }))
      if (body.token !== undefined) {
        if (updated.auth.type !== 'token') throw new Error(`${updated.title} does not use a token`)
        store.setSecrets(id, (s) => ({ ...s, token: body.token }))
      }
      if (body.clientId !== undefined || body.clientSecret !== undefined) {
        if (updated.kind !== 'gmail') throw new Error(`${updated.title} does not use a Google OAuth client`)
        store.setSecrets(id, (s) => ({
          ...s,
          // A new client invalidates the old grant: sign in again.
          google: { clientId: body.clientId ?? s.google?.clientId ?? '', clientSecret: body.clientSecret ?? s.google?.clientSecret ?? '' },
        }))
      }
      return { connector: connectorView(store, store.get(id)!) }
    } catch (e) {
      return reply.code(400).send({ error: errorOf(e) })
    }
  })

  app.delete('/api/connectors/:id', async (req, reply) => {
    const store = storeOr409(reply)
    if (!store) return reply
    const { id } = req.params as { id: string }
    if (!store.remove(id)) return reply.code(404).send({ error: 'no such connector' })
    return { ok: true }
  })

  app.post('/api/connectors/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string }
    const builtin = builtinConnector(id)
    let upstream: Upstream
    let record: ConnectorRecord | null = null
    try {
      if (builtin) {
        upstream = await connectInProcess(builtin.createServer({ runId: 'connection-test', agentId: 'connection-test', connectorId: id, evidence: () => {} }))
      } else {
        record = deps.store?.get(id) ?? null
        if (!record || !deps.store) return reply.code(404).send({ error: 'no such connector' })
        upstream = await open(deps.store, record)
      }
    } catch (e) {
      return reply.code(e instanceof NeedsSignInError ? 409 : 502).send({ error: describeOpenFailure(builtin?.title ?? record?.title ?? id, e) })
    }
    let tools: UpstreamTool[]
    try {
      tools = await upstream.listTools()
    } catch (e) {
      return reply.code(502).send({ error: describeOpenFailure(builtin?.title ?? record?.title ?? id, e) })
    } finally {
      await upstream.close().catch(() => {})
    }
    if (record && deps.store) {
      const updated = deps.store.update(id, (r) => ({ ...r, tools: snapshot(tools), toolsCheckedAt: now() }))
      return { connector: connectorView(deps.store, updated) }
    }
    return { tools: snapshot(tools).map((t) => ({ ...t, classification: 'read' as const })) }
  })

  app.get('/api/connectors/import', async () => {
    const taken = new Set(deps.store?.list().map((c) => c.id) ?? [])
    const imported = new Set(deps.store?.list().flatMap((c) => (c.origin.type === 'imported' ? [`${c.origin.source}:${c.origin.name}`] : [])) ?? [])
    const servers = discoverClaudeCodeServers({ home: deps.home, cwd: deps.cwd })
    return {
      servers: servers.map((s) => ({
        ...maskDiscovered(s),
        from: sourceLabel(s),
        suggestedId: suggestConnectorId(s.name, taken),
        imported: imported.has(`${s.source}:${s.sourcePath}:${s.name}`),
      })),
    }
  })

  app.post('/api/connectors/import', async (req, reply) => {
    const store = storeOr409(reply)
    if (!store) return reply
    try {
      const body = z.object({ key: z.string().min(1), id: idSchema.optional() }).parse(req.body ?? {})
      const server = discoverClaudeCodeServers({ home: deps.home, cwd: deps.cwd }).find((s) => s.key === body.key)
      if (!server) return reply.code(404).send({ error: 'that server is no longer in Claude Code\'s configuration' })
      const taken = new Set(store.list().map((c) => c.id))
      const id = body.id ?? suggestConnectorId(server.name, taken)
      if (builtinConnector(id)) throw new Error(`"${id}" is a built-in connector's id`)
      const { record, secrets } = importedConnector(server, id, now())
      return reply.code(201).send({ connector: connectorView(store, store.create(record, secrets)) })
    } catch (e) {
      return reply.code(400).send({ error: errorOf(e) })
    }
  })

  app.post('/api/connectors/:id/oauth/start', async (req, reply) => {
    const store = storeOr409(reply)
    if (!store) return reply
    const { id } = req.params as { id: string }
    const record = store.get(id)
    if (!record) return reply.code(404).send({ error: 'no such connector' })
    let redirectUri: string
    try {
      redirectUri = loopbackCallbackUrl(req.headers.host, OAUTH_CALLBACK_PATH)
    } catch (e) {
      return reply.code(400).send({ error: errorOf(e) })
    }
    sweepFlows()
    const state = oauthState()
    if (record.kind === 'gmail') {
      const google = store.secrets(id).google
      if (!google?.clientId) return reply.code(400).send({ error: 'add the Google OAuth client ID and secret first' })
      const { verifier, challenge } = pkcePair()
      flows.set(state, { connectorId: id, kind: 'gmail', redirectUri, verifier, expiresAt: now() + FLOW_TTL_MS })
      return { authorizationUrl: googleAuthUrl({ clientId: google.clientId, redirectUri, state, codeChallenge: challenge }) }
    }
    if (record.auth.type !== 'oauth-mcp' || record.transport.type !== 'http') {
      return reply.code(400).send({ error: `${record.title} does not sign in with OAuth` })
    }
    const serverUrl = record.transport.url ?? store.secrets(id).url
    if (!serverUrl) return reply.code(400).send({ error: `${record.title} has no URL` })
    let authorizationUrl: string | null = null
    const provider = new StoredMcpOAuthProvider(store, id, { title: record.title, redirectUrl: redirectUri, state, onRedirect: (url) => { authorizationUrl = url.toString() } })
    try {
      const result = await auth(provider, { serverUrl, ...(deps.fetch ? { fetchFn: deps.fetch } : {}) })
      if (result === 'AUTHORIZED') return { connected: true }
    } catch (e) {
      return reply.code(502).send({ error: describeOpenFailure(record.title, e) })
    }
    if (!authorizationUrl) return reply.code(502).send({ error: `${record.title} did not offer a sign-in page` })
    flows.set(state, { connectorId: id, kind: 'mcp', redirectUri, expiresAt: now() + FLOW_TTL_MS })
    return { authorizationUrl }
  })

  app.get(OAUTH_CALLBACK_PATH, async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string }
    sweepFlows()
    const flow = typeof q.state === 'string' ? flows.get(q.state) : undefined
    if (!flow || !q.state) return page(reply, 400, 'Sign-in not recognised', 'This sign-in link expired or was not started from this dashboard. Start it again from the Connectors page.')
    flows.delete(q.state)
    const store = deps.store
    const record = store?.get(flow.connectorId)
    if (!store || !record) return page(reply, 404, 'Connector removed', 'The connector this sign-in was for no longer exists.')
    if (q.error || !q.code) return page(reply, 400, 'Sign-in cancelled', `${record.title} was not connected${q.error ? ` (${String(q.error).slice(0, 60)})` : ''}.`)
    try {
      if (flow.kind === 'gmail') {
        const google = store.secrets(record.id).google!
        const tokens = await exchangeGoogleCode({
          clientId: google.clientId, clientSecret: google.clientSecret, code: q.code, codeVerifier: flow.verifier!, redirectUri: flow.redirectUri,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        })
        if (!tokens.refreshToken) throw new Error('Google returned no refresh token; remove the app\'s access in your Google account and connect again')
        store.setSecrets(record.id, (s) => ({ ...s, google: { ...s.google!, refreshToken: tokens.refreshToken!, scope: tokens.scope } }))
      } else {
        const serverUrl = (record.transport.type === 'http' ? record.transport.url : null) ?? store.secrets(record.id).url!
        const provider = new StoredMcpOAuthProvider(store, record.id, { title: record.title, redirectUrl: flow.redirectUri, state: q.state })
        await auth(provider, { serverUrl, authorizationCode: q.code, ...(deps.fetch ? { fetchFn: deps.fetch } : {}) })
      }
    } catch (e) {
      return page(reply, 502, 'Sign-in failed', describeOpenFailure(record.title, e))
    }
    return page(reply, 200, `${record.title} connected`, 'You can close this tab and return to the dashboard.')
  })
}
