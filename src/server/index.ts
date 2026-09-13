import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDashboard } from './create-dashboard.js'
import { openBrowser, probeDashboard } from './open-browser.js'
import { resolveStartOptions, type StartOptions } from './start-options.js'

// src/server/index.ts -> the project root, so data and the built UI are found however the
// app was launched (a double-clicked shortcut does not start in the project directory).
const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

let options: StartOptions
try {
  options = resolveStartOptions({
    argv: process.argv.slice(2),
    env: process.env,
    projectRoot,
    home: homedir(),
    exists: existsSync,
  })
} catch (e) {
  console.error(`Agent Tournament: ${(e as Error).message}`)
  process.exit(2)
}

// 127.0.0.1 rather than localhost: the server binds IPv4 loopback only, and on Windows
// `localhost` can resolve to ::1 first.
const url = `http://127.0.0.1:${options.port}`

// Probe BEFORE opening the database. createDashboard recovers interrupted rounds by marking
// every unfinished round failed, so a second launch that opened the same file would fail the
// running instance's in-flight round out from under it. Launching twice should just bring
// up the app that is already running, like any other app.
if (await probeDashboard(url)) {
  console.log(`Agent Tournament is already running at ${url}`)
  if (options.open) openBrowser(url, (message) => console.warn(message))
  // Give the launcher a moment to be handed off before this process exits.
  setTimeout(() => process.exit(0), 500)
} else {
  await start(options)
}

async function start(o: StartOptions): Promise<void> {
  if (o.dbPath !== ':memory:') mkdirSync(dirname(o.dbPath), { recursive: true })

  const dashboard = createDashboard({
    dbPath: o.dbPath,
    population: o.population,
    workspaceRoot: o.workspaceRoot,
    authFile: o.authFile,
    serverUrl: o.serverUrl,
    uiDir: o.uiDir,
  })
  if (dashboard.recovered > 0) {
    console.log(`recovered ${dashboard.recovered} interrupted round(s)`)
  }
  dashboard.attachWebSocket()

  try {
    await dashboard.app.listen({ port: o.port, host: '127.0.0.1' })
  } catch (e) {
    await dashboard.shutdown().catch(() => {})
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // Not ours — the probe above already ruled that out.
      console.error(
        `Port ${o.port} is being used by another program. ` +
          `Start on a different port with: npm start -- --port ${o.port + 100}`,
      )
      process.exit(1)
    }
    throw e
  }

  console.log('')
  console.log(`  Agent Tournament is running at ${url}`)
  console.log('')
  console.log(`  data         ${o.dbPath}`)
  console.log(`  workspaces   ${o.workspaceRoot}`)
  console.log(
    `  credentials  ${o.authFile ?? 'none found (docker runs will be refused; run `opencode auth login`)'}`,
  )
  console.log('')
  console.log('  Press Ctrl+C, or close this window, to stop.')
  console.log('')

  if (o.open) openBrowser(url, (message) => console.warn(message))

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    console.log('stopping...')
    await dashboard.shutdown().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  // Closing the console window on Windows arrives as SIGHUP, with a few seconds to finish.
  // Without this, closing the window skipped shutdown and left docker containers running.
  process.on('SIGHUP', stop)
}
