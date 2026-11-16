import type { RunConfig } from '../../core/types.js'
import { builtinConnector, registerBuiltinConnector } from '../builtins.js'
import { describeWebCall } from './evidence.js'
import { DEFAULT_WEB_LIMITS } from './limits.js'
import { webConnector } from './mcp-server.js'
import { WEB_MCP_SERVER } from './opencode.js'

/**
 * The web tools as a built-in connector: every run reaches them through the tool bridge, in every sandbox, with the
 * bridge's per-agent tokens, limits and evidence. The id is the MCP server name agents already know the tools by
 * (`arena_web_search`, `arena_web_fetch`). A run turns them on with `webAccess`, not by listing the connector.
 */
export const WEB_CONNECTOR_ID = WEB_MCP_SERVER

/**
 * The identity a collaboration team's agents share on the bridge. A team works in one folder, so it has one
 * `.opencode/opencode.json` and one token; per-agent attribution comes from the OpenCode activity stream instead.
 */
export const TEAM_AGENT_ID = 'team'

const perAgent = webConnector()
// A team is one identity, so it is bounded by the run-wide caps rather than one agent's.
const team = webConnector({
  limits: { searchesPerAgent: DEFAULT_WEB_LIMITS.searchesPerRun, fetchesPerAgent: DEFAULT_WEB_LIMITS.fetchesPerRun },
})

/** Registers the web connector once per process; later calls are no-ops. */
export function ensureWebConnector(): void {
  if (builtinConnector(WEB_CONNECTOR_ID)) return
  registerBuiltinConnector({
    id: WEB_CONNECTOR_ID,
    title: 'Web search and fetch',
    readOnly: true,
    description: 'Searches the web (LangSearch, falling back to Exa) and reads public pages as text.',
    createServer: (ctx) => (ctx.agentId === TEAM_AGENT_ID ? team : perAgent).createServer({
      runId: ctx.runId,
      agentId: ctx.agentId,
      evidence: (record) => {
        const { summary, detail } = describeWebCall(record)
        ctx.evidence({ summary, detail, kind: 'network' })
      },
    }),
  })
}

/** Closes a stopped run's web limiters, so a late call is refused rather than counted. */
export function endWebRun(runId: string): void {
  perAgent.endRun(runId)
  team.endRun(runId)
}

/** Whether a run's agents get the web tools: asked for, and a sandbox with real agents. */
export function runHasWeb(config: Pick<RunConfig, 'sandbox' | 'webAccess'>): boolean {
  return config.webAccess === true && config.sandbox !== 'mock'
}

/** Every connector id an agent's profile must allow: the run's own, plus the web tools when it has them. */
export function agentConnectorIds(config: Pick<RunConfig, 'sandbox' | 'webAccess' | 'connectors'>): string[] {
  const ids = (config.connectors ?? []).map((c) => c.id).filter((id) => id !== WEB_CONNECTOR_ID)
  return runHasWeb(config) ? [...ids, WEB_CONNECTOR_ID] : ids
}
