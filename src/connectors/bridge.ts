import { randomBytes, randomUUID } from 'node:crypto'
import { ErrorCode, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { redactSecrets } from '../core/redact.js'
import type { ConnectorCall, ConnectorCallStatus, ConnectorNote, EngineEvent } from '../engine/events.js'
import { exposedToolNames, policySubjectFor, type UpstreamTool } from './policy.js'
import type { ConnectorKind, ToolPolicy } from './types.js'
import type { Upstream } from './upstream.js'

/**
 * The decision half of the host tool bridge: which agent is calling, may it call this tool, and what is recorded.
 *
 * Workers hold no connector credential. Each agent gets its own bearer token for the run, so a call is attributed by
 * the host, not by anything the worker says. The tool policy is applied here, from the connector's kind and stored
 * policy: a locked connector's exposure comes from its code-defined allowlist whatever the caller passes. Every call
 * is bounded (count per agent, time, result size) and recorded as an `agent.connector` event with metadata only.
 */

export type ConnectorEvent = Extract<EngineEvent, { type: 'agent.connector' }>

export interface BridgeLimits {
  callTimeoutMs: number
  maxResponseBytes: number
  maxRequestBytes: number
}

export const DEFAULT_BRIDGE_LIMITS: BridgeLimits = {
  callTimeoutMs: 60_000,
  maxResponseBytes: 256 * 1024,
  maxRequestBytes: 256 * 1024,
}

/** A ceiling on connector tool calls per agent over a run. */
export const TOOL_CALLS_PER_AGENT = 500

export interface GrantConnector {
  id: string
  title: string
  kind: ConnectorKind | 'builtin'
  policy: ToolPolicy
  /** Write tools this run opted into; only those the connector also permits are ever exposed. */
  runWriteOptIns: readonly string[]
  /** Every tool the upstream listed when the run started. */
  upstreamTools: readonly UpstreamTool[]
  /** The upstream an agent's calls go to: shared by the run's agents, or one per agent for built-ins. */
  upstream: (agentId: string) => Promise<Upstream>
}

export interface GrantSpec {
  /** The live run id, read when an event is emitted: the run row may not exist yet when the grant is made. */
  runId: () => string
  connectors: readonly GrantConnector[]
  maxCallsPerAgent: number
  onEvent: (event: ConnectorEvent) => void
  /** Closes the run's upstreams; called once, on revoke. */
  close: () => Promise<void>
  /**
   * Credentials that may sit inside a worker (a Claude setup token in a protected container) and must never leave
   * it through a tool call: a call whose arguments carry one, plainly or in a common encoding, is refused.
   */
  guardedSecrets?: () => Promise<readonly string[]>
}

/** The spellings a credential is most likely to be smuggled in: as is, percent-encoded, and base64 / base64url. */
export function carriesSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => {
    if (secret.length < 16) return false
    const b64 = Buffer.from(secret).toString('base64').replace(/=+$/, '')
    const forms = [secret, encodeURIComponent(secret), b64, b64.replace(/\+/g, '-').replace(/\//g, '_')]
    return forms.some((form) => text.includes(form))
  })
}

/** What one agent's runner needs to reach one connector: a URL and the headers to send. Runner-agnostic. */
export interface McpEndpoint {
  id: string
  title: string
  url: string
  headers: Record<string, string>
}

export interface ToolGrant {
  readonly connectorIds: readonly string[]
  /** The tools each connector exposes in this run, in upstream order. */
  exposed(connectorId: string): Tool[]
  tokenFor(agentId: string): string
  /** `baseUrl` is how this agent's runtime reaches the bridge, e.g. `http://gateway:8788`. */
  endpointsFor(agentId: string, baseUrl: string): McpEndpoint[]
}

export interface BridgeCaller {
  grantId: string
  agentId: string
}

interface GrantState {
  grantId: string
  spec: GrantSpec
  exposed: Map<string, Tool[]>
  allowed: Map<string, Set<string>>
  calls: Map<string, number>
  tokens: Map<string, string>
}

const MAX_ARG_KEYS = 20

/** Definitions as the worker sees them: what an MCP client needs, nothing upstream-private. */
function publicTool(tool: UpstreamTool): Tool {
  const out: Record<string, unknown> = { name: tool.name, inputSchema: tool.inputSchema }
  for (const key of ['title', 'description', 'outputSchema', 'annotations'] as const) {
    if (tool[key] !== undefined) out[key] = tool[key]
  }
  return out as Tool
}

const errorResult = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] })

function argKeysOf(args: Record<string, unknown>): string[] {
  return Object.keys(args).slice(0, MAX_ARG_KEYS).map((k) => k.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64))
}

export class ToolBridge {
  private grants = new Map<string, GrantState>()
  private byToken = new Map<string, { grantId: string; agentId: string }>()

  constructor(readonly limits: BridgeLimits = DEFAULT_BRIDGE_LIMITS, private readonly now: () => number = Date.now) {}

  /** Issues or replaces a run's grant; tokens of a replaced grant stop working at once. */
  grant(grantId: string, spec: GrantSpec): ToolGrant {
    const previous = this.grants.get(grantId)
    if (previous) this.drop(previous)
    const state: GrantState = { grantId, spec, exposed: new Map(), allowed: new Map(), calls: new Map(), tokens: new Map() }
    for (const c of spec.connectors) {
      const names = exposedToolNames(policySubjectFor({ kind: c.kind, policy: c.policy }), c.upstreamTools, c.runWriteOptIns)
      state.allowed.set(c.id, names)
      state.exposed.set(c.id, c.upstreamTools.filter((t) => names.has(t.name)).map(publicTool))
    }
    this.grants.set(grantId, state)
    const tokenFor = (agentId: string): string => {
      if (this.grants.get(grantId) !== state) throw new Error('this tool grant has been revoked')
      let token = state.tokens.get(agentId)
      if (!token) {
        token = randomBytes(24).toString('hex')
        state.tokens.set(agentId, token)
        this.byToken.set(token, { grantId, agentId })
      }
      return token
    }
    return {
      connectorIds: spec.connectors.map((c) => c.id),
      exposed: (id) => [...(state.exposed.get(id) ?? [])],
      tokenFor,
      endpointsFor: (agentId, baseUrl) => {
        const token = tokenFor(agentId)
        return spec.connectors.map((c) => ({
          id: c.id,
          title: c.title,
          url: `${baseUrl.replace(/\/+$/, '')}/mcp/${c.id}`,
          headers: { Authorization: `Bearer ${token}` },
        }))
      },
    }
  }

  /** First thing a stopping run does: later requests with its tokens are unauthenticated; its upstreams close. */
  async revoke(grantId: string): Promise<void> {
    const state = this.grants.get(grantId)
    if (!state) return
    this.drop(state)
    await state.spec.close().catch(() => {})
  }

  private drop(state: GrantState): void {
    if (this.grants.get(state.grantId) === state) this.grants.delete(state.grantId)
    for (const token of state.tokens.values()) this.byToken.delete(token)
  }

  authenticate(token: string | null | undefined): BridgeCaller | null {
    if (!token) return null
    const found = this.byToken.get(token)
    return found && this.grants.has(found.grantId) ? { ...found } : null
  }

  /** Whether the caller's run enabled this connector. */
  hasConnector(caller: BridgeCaller, connectorId: string): boolean {
    return this.grants.get(caller.grantId)?.allowed.has(connectorId) ?? false
  }

  listTools(caller: BridgeCaller, connectorId: string): Tool[] {
    return [...(this.grants.get(caller.grantId)?.exposed.get(connectorId) ?? [])]
  }

  async callTool(caller: BridgeCaller, connectorId: string, tool: string, rawArgs: unknown): Promise<CallToolResult> {
    const state = this.grants.get(caller.grantId)
    if (!state) return errorResult('This run has stopped; connector tools are no longer available.')
    const connector = state.spec.connectors.find((c) => c.id === connectorId)
    if (!connector) return errorResult('This connector is not enabled for this run.')
    const started = this.now()
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {}
    const requestBytes = Buffer.byteLength(JSON.stringify(args))
    const base = { id: randomUUID(), tool: tool.slice(0, 128), argKeys: argKeysOf(args), requestBytes }
    const record = (call: Omit<ConnectorCall, keyof typeof base | 'durationMs'>) => {
      this.emit(state, caller.agentId, connectorId, { ...base, ...call, durationMs: this.now() - started })
    }

    if (!state.allowed.get(connectorId)?.has(tool)) {
      record({ outcome: 'denied', status: 'refused', responseBytes: 0, error: 'tool not exposed to agents' })
      return errorResult(`The tool ${tool} is not available through the ${connector.title} connector.`)
    }
    const secrets = (await state.spec.guardedSecrets?.().catch(() => [])) ?? []
    if (secrets.length > 0 && carriesSecret(JSON.stringify(args), secrets)) {
      record({ outcome: 'denied', status: 'refused', responseBytes: 0, error: 'request carried a protected credential' })
      return errorResult('Refused: this request contains a credential this run protects.')
    }
    const used = state.calls.get(caller.agentId) ?? 0
    if (used >= state.spec.maxCallsPerAgent) {
      record({ outcome: 'denied', status: 'limit', responseBytes: 0, error: `call limit of ${state.spec.maxCallsPerAgent} reached` })
      return errorResult(`You have used all ${state.spec.maxCallsPerAgent} connector tool calls this run allows.`)
    }
    state.calls.set(caller.agentId, used + 1)

    let result: CallToolResult
    try {
      const upstream = await connector.upstream(caller.agentId)
      result = await upstream.callTool(tool, args, { timeoutMs: this.limits.callTimeoutMs })
    } catch (e) {
      const timedOut = e instanceof McpError && e.code === ErrorCode.RequestTimeout
      const status: ConnectorCallStatus = timedOut ? 'timeout' : 'upstream_error'
      const error = timedOut ? `no answer within ${this.limits.callTimeoutMs} ms` : 'upstream failed'
      record({ outcome: 'failed', status, responseBytes: 0, error })
      return errorResult(timedOut
        ? `The ${connector.title} connector did not answer within ${Math.round(this.limits.callTimeoutMs / 1000)} seconds.`
        : `The ${connector.title} connector failed to answer.`)
    }
    const responseBytes = Buffer.byteLength(JSON.stringify(result))
    if (responseBytes > this.limits.maxResponseBytes) {
      record({ outcome: 'failed', status: 'too_large', responseBytes, error: `result exceeded ${this.limits.maxResponseBytes} bytes` })
      return errorResult(`The result was larger than ${Math.round(this.limits.maxResponseBytes / 1024)} KiB. Ask for less: a narrower query, fewer results, or one item at a time.`)
    }
    record(result.isError ? { outcome: 'failed', status: 'error', responseBytes, error: 'tool reported an error' } : { outcome: 'completed', status: 'ok', responseBytes })
    return result
  }

  /** A built-in's note under one agent, bounded and redacted. Never throws. */
  note(grantId: string, agentId: string, connectorId: string, note: { summary: string; detail?: string; kind?: ConnectorNote['kind'] }): void {
    const state = this.grants.get(grantId)
    if (!state) return
    const summary = redactSecrets(String(note.summary ?? '')).slice(0, 300)
    const detail = note.detail === undefined ? undefined : redactSecrets(String(note.detail)).slice(0, 2048)
    this.safeEmit(state, {
      type: 'agent.connector', runId: state.spec.runId(), agentId, connectorId, at: this.now(),
      note: { kind: note.kind === 'network' ? 'network' : 'tool', summary, ...(detail !== undefined ? { detail } : {}) },
    })
  }

  private emit(state: GrantState, agentId: string, connectorId: string, call: ConnectorCall): void {
    this.safeEmit(state, { type: 'agent.connector', runId: state.spec.runId(), agentId, connectorId, at: this.now(), call })
  }

  private safeEmit(state: GrantState, event: ConnectorEvent): void {
    try {
      state.spec.onEvent(event)
    } catch {
      /* a recorder failure must not break a tool call */
    }
  }
}
