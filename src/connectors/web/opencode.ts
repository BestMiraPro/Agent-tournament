import type { WebLimits } from './limits.js'

/**
 * How an OpenCode worker is pointed at the web tools.
 *
 * OpenCode 1.18.21 loads `.opencode/opencode.json` from each session directory's instance, connects
 * to a `remote` MCP server over Streamable HTTP with the given headers, names its tools
 * `<server>_<tool>` and asks permission under those names (verified in the 1.18.21 source:
 * `mcp/index.ts`, `mcp/catalog.ts`, `session/tools.ts`). `oauth: false` keeps a refused token from
 * starting an OAuth flow nobody can answer; the timeout covers a search that falls back.
 */

export const WEB_MCP_SERVER = 'arena'
export const WEB_TOOL_NAMES = [`${WEB_MCP_SERVER}_web_search`, `${WEB_MCP_SERVER}_web_fetch`] as const
export const WEB_MCP_TIMEOUT_MS = 60_000

/** The workspace's `.opencode/opencode.json` for one agent. */
export function webOpencodeConfig(url: string, token: string): string {
  return `${JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      [WEB_MCP_SERVER]: {
        type: 'remote',
        url,
        headers: { Authorization: `Bearer ${token}` },
        oauth: false,
        timeout: WEB_MCP_TIMEOUT_MS,
      },
    },
  }, null, 2)}\n`
}

/**
 * Permission rules a local competitor gets on top of its profile. OpenCode's own `websearch` is
 * denied either way: the host server runs with Exa search enabled for the grader, and a worker's
 * searches should be the audited, limited ones. The web tools are allowed only when the run has
 * web access (they are not configured otherwise).
 */
export function localToolRules(webAccess: boolean): Record<string, 'allow' | 'deny'> {
  return {
    websearch: 'deny',
    ...(webAccess ? Object.fromEntries(WEB_TOOL_NAMES.map((name) => [name, 'allow' as const])) : {}),
  }
}

/** What the agent prompt says about the tools. */
export function webToolsPrompt(limits: WebLimits): string {
  return [
    `Web access: search with the ${WEB_TOOL_NAMES[0]} tool and read pages with ${WEB_TOOL_NAMES[1]} (public http/https pages, returned as text).`,
    `OpenCode's own webfetch and websearch are disabled. Every web call is recorded as evidence; you have ${limits.searchesPerAgent} searches and ${limits.fetchesPerAgent} page fetches for this run.`,
  ].join('\n')
}
