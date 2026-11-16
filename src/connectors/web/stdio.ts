import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readWebSearchKeys } from './config.js'
import { WebLimiter } from './limits.js'
import { createWebMcpServer } from './mcp-server.js'

/**
 * The web tools over stdio, for an MCP client on the host (`npx tsx src/connectors/web/stdio.ts`).
 * Keys come from this process's environment or the repository `.env`, as for the dashboard.
 * stdout is the protocol channel, so each call's evidence record is one JSON line on stderr.
 * Tournament runs do not use this: their workers reach the in-process server the dashboard owns.
 */
const server = createWebMcpServer({
  runId: process.env.ARENA_WEB_RUN_ID || 'stdio',
  agentId: process.env.ARENA_WEB_AGENT_ID || 'stdio',
  limiter: new WebLimiter(),
  keys: () => readWebSearchKeys(),
  evidence: (record) => {
    process.stderr.write(`${JSON.stringify(record)}\n`)
  },
})

await server.connect(new StdioServerTransport())
