import type { RunConnector } from '../core/types.js'
import type { ManifestConnector } from '../runtime/tool-manifest.js'
import { TOOL_CALLS_PER_AGENT, type ConnectorEvent, type GrantConnector, type ToolBridge, type ToolGrant } from './bridge.js'
import { classifyTool, policySubjectFor } from './policy.js'
import { lockFor } from './presets.js'
import { describeOpenFailure, type ConnectorResolver, type ResolvedConnector } from './resolve.js'
import type { Upstream } from './upstream.js'

/** A run's connectors once granted: how agents reach them, what TOOLS.md says, and how the run lets go of them. */
export interface ConnectorRunPlan {
  grant: ToolGrant
  manifest: ManifestConnector[]
  /** First thing a stopping run calls: tokens stop working and upstreams close. */
  revoke: () => Promise<void>
  /** The run's connector events, for the audit and the live dashboard. */
  subscribe: (sink: (event: ConnectorEvent) => void) => () => void
}

const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_')

/** OpenCode's name for an MCP tool (opencode 1.18.21 `McpCatalog.toolName`). */
export const agentToolName = (connectorId: string, tool: string) => `${sanitize(connectorId)}_${sanitize(tool)}`

function assertOptIns(c: ResolvedConnector, writeTools: readonly string[]): void {
  if (writeTools.length === 0) return
  if (lockFor(c.kind) || c.kind === 'builtin') {
    throw new Error(`${c.title} is read-only: no write tool can be enabled for it`)
  }
  for (const tool of writeTools) {
    if (!c.policy.writeTools.includes(tool)) {
      throw new Error(`${c.title} does not permit the write tool ${tool}: permit it on the Connectors page first, or leave it off this run`)
    }
  }
}

/**
 * Resolves a run's connectors, opens each upstream on the host and lists its tools, then grants the run on the tool
 * bridge. Refuses the whole run, naming the connector, when one does not exist, asks for writes it may not have, or
 * cannot connect; everything opened before the failure is closed again.
 */
export async function planRunConnectors(opts: {
  wanted: readonly RunConnector[]
  resolver: ConnectorResolver
  bridge: ToolBridge
  grantId: string
  runId: () => string
  maxCallsPerAgent?: number
  guardedSecrets?: () => Promise<readonly string[]>
}): Promise<ConnectorRunPlan> {
  const resolved = opts.wanted.map((w) => {
    const c = opts.resolver.resolve(w.id)
    if (!c) throw new Error(`Connector "${w.id}" does not exist: add it on the Connectors page, or remove it from this run.`)
    assertOptIns(c, w.writeTools)
    return { c, writeTools: w.writeTools }
  })

  const opened: Upstream[] = []
  const perAgent = new Map<string, Map<string, Promise<Upstream>>>()
  const closeAll = async () => {
    const pending = [...opened, ...await Promise.all([...perAgent.values()].flatMap((m) => [...m.values()].map((p) => p.catch(() => null))))]
    opened.length = 0
    perAgent.clear()
    await Promise.all(pending.map((u) => u?.close().catch(() => {})))
  }

  const listeners = new Set<(event: ConnectorEvent) => void>()
  const note = (agentId: string, connectorId: string) => (n: { summary: string; detail?: string; kind?: 'tool' | 'network' }) =>
    opts.bridge.note(opts.grantId, agentId, connectorId, n)

  const grantConnectors: GrantConnector[] = []
  try {
    for (const { c, writeTools } of resolved) {
      let upstreamTools
      let shared: Upstream | null = null
      try {
        const first = await c.open({ runId: opts.runId(), agentId: '', note: () => {} })
        try {
          upstreamTools = await first.listTools()
        } catch (e) {
          await first.close()
          throw e
        }
        if (c.perAgent) await first.close()
        else {
          shared = first
          opened.push(first)
        }
      } catch (e) {
        throw new Error(describeOpenFailure(c.title, e))
      }
      const agentUpstreams = new Map<string, Promise<Upstream>>()
      perAgent.set(c.id, agentUpstreams)
      grantConnectors.push({
        id: c.id,
        title: c.title,
        kind: c.kind,
        policy: c.policy,
        runWriteOptIns: writeTools,
        upstreamTools,
        upstream: async (agentId) => {
          if (shared) return shared
          let pending = agentUpstreams.get(agentId)
          if (!pending) {
            pending = c.open({ runId: opts.runId(), agentId, note: note(agentId, c.id) })
            agentUpstreams.set(agentId, pending)
            pending.catch(() => { if (agentUpstreams.get(agentId) === pending) agentUpstreams.delete(agentId) })
          }
          return pending
        },
      })
    }
  } catch (e) {
    await closeAll()
    throw e
  }

  const grant = opts.bridge.grant(opts.grantId, {
    runId: opts.runId,
    connectors: grantConnectors,
    maxCallsPerAgent: opts.maxCallsPerAgent ?? TOOL_CALLS_PER_AGENT,
    onEvent: (event) => {
      for (const listener of listeners) {
        try {
          listener(event)
        } catch {
          /* a dashboard subscriber must never break a tool call */
        }
      }
    },
    close: closeAll,
    ...(opts.guardedSecrets ? { guardedSecrets: opts.guardedSecrets } : {}),
  })

  const manifest: ManifestConnector[] = grantConnectors.map((g) => {
    const subject = policySubjectFor({ kind: g.kind, policy: g.policy })
    return {
      id: g.id,
      title: g.title,
      tools: grant.exposed(g.id).map((t) => ({
        name: agentToolName(g.id, t.name),
        description: (t.description ?? '').split('\n')[0]!.slice(0, 160),
        write: classifyTool(subject, t) === 'write',
      })),
    }
  })

  return {
    grant,
    manifest,
    revoke: () => opts.bridge.revoke(opts.grantId),
    subscribe: (sink) => {
      listeners.add(sink)
      return () => { listeners.delete(sink) }
    },
  }
}
