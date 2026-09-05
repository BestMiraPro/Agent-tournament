import { parseArgs } from 'node:util'
import { createDashboard } from './create-dashboard.js'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4300' },
    db: { type: 'string', default: ':memory:' },
    population: { type: 'string', default: '8' },
    'workspace-root': { type: 'string' },
    'auth-file': { type: 'string' },
    // Under strict run-spec validation the body must already carry workspaceRoot/authFile,
    // so only --server-url can fire as a fallback.
    'server-url': { type: 'string' },
  },
})

const port = Number(values.port)

// All wiring lives in createDashboard so this entry point and the end-to-end tests
// exercise the same object graph. They used to build it separately, which is how the
// servers kept a keyword-free seed strategy long after the CLI was fixed.
const dashboard = createDashboard({
  dbPath: values.db,
  population: Number(values.population),
  workspaceRoot: values['workspace-root'] ?? null,
  authFile: values['auth-file'] ?? null,
  serverUrl: values['server-url'] ?? null,
})

if (dashboard.recovered > 0) {
  console.log(`recovered ${dashboard.recovered} interrupted round(s)`)
}

dashboard.attachWebSocket()

await dashboard.app.listen({ port, host: '127.0.0.1' })
console.log(`dashboard API on http://127.0.0.1:${port}`)
console.log(`websocket on ws://127.0.0.1:${port}/ws`)
console.log(`run the UI with: npm run web:dev`)

const shutdown = async () => {
  await dashboard.shutdown().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
