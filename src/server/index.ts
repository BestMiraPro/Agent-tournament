import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bridgeCredentials, opencode2Candidates } from '../runtime/opencode/credential-bridge.js'
import { configureHostOpencode } from '../runtime/opencode/pinned.js'
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

// 127.0.0.1 rather than localhost: the server binds IPv4 loopback by default, and on Windows
// `localhost` can resolve to ::1 first. A server bound to 0.0.0.0 answers here too.
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

/**
 * No OpenCode 1.x auth.json: borrow the API keys from an installed OpenCode 2.x, written as a
 * private auth.json the pinned host server and Docker runs can use.
 */
async function bridgeOpencode2Credentials(o: StartOptions): Promise<void> {
  // A data dir keeps its own logins; OpenCode 2's keys belong to whoever installed it.
  if (o.authFile || o.dataDir) return
  const dataHome = join(projectRoot, 'runs', 'secrets', 'opencode')
  const bridged = await bridgeCredentials({ dataHome, candidates: opencode2Candidates(process.env) }).catch(() => null)
  if (!bridged) return
  o.authFile = bridged.authFile
  // The pinned server keeps its own data here, apart from OpenCode 2's.
  configureHostOpencode({ env: { XDG_DATA_HOME: dataHome } })
  console.log(`  credentials from OpenCode 2: ${bridged.integrations.join(', ')}`)
  if (bridged.skipped.length) console.log(`  not carried over: ${bridged.skipped.join(', ')}`)
}

async function start(o: StartOptions): Promise<void> {
  if (o.dbPath !== ':memory:') mkdirSync(dirname(o.dbPath), { recursive: true })
  if (o.opencodeDataHome) {
    mkdirSync(o.opencodeDataHome, { recursive: true, mode: 0o700 })
    // The host server reads and refreshes its logins here, so a profile's sign-in stays its own.
    configureHostOpencode({ env: { XDG_DATA_HOME: o.opencodeDataHome } })
  }
  await bridgeOpencode2Credentials(o)

  const dashboard = createDashboard({
    dbPath: o.dbPath,
    host: o.host,
    population: o.population,
    workspaceRoot: o.workspaceRoot,
    authFile: o.authFile,
    serverUrl: o.serverUrl,
    uiDir: o.uiDir,
    dockerSandbox: o.dockerSandbox,
    dockerReach: o.dockerReach,
    connectorsDir: o.connectorsDir,
    ...(o.claudeTokenFile ? { claudeTokenFile: o.claudeTokenFile } : {}),
    hostClaudeLogin: o.hostClaudeLogin,
  })
  if (dashboard.recovered > 0) {
    console.log(`recovered ${dashboard.recovered} interrupted round(s)`)
  }
  dashboard.attachWebSocket()

  try {
    await dashboard.app.listen({ port: o.port, host: o.host })
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
  console.log(`  connectors   ${o.connectorsDir}`)
  console.log(
    `  credentials  ${o.authFile ?? (o.opencodeDataHome
      ? `none in this data dir (sign in with: XDG_DATA_HOME="${o.opencodeDataHome}" npx opencode auth login)`
      : 'none found (docker runs will be refused; run `opencode auth login`)')}`,
  )
  if (o.claudeTokenFile) console.log(`  claude       ${o.claudeTokenFile} (setup token only; this machine's own Claude login is not used)`)
  if (!o.dockerSandbox) console.log('  docker runs  off (--no-docker-sandbox)')
  else if (o.dockerReach === 'bridge') console.log("  docker runs  from this container, over Docker's bridge network")
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
