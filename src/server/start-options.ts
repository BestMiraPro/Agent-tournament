import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import type { DockerReach } from '../runtime/docker/container.js'

export interface StartOptions {
  port: number
  /**
   * Address the server binds. Loopback by default: the dashboard has no authentication.
   * The container image binds 0.0.0.0 inside its own network namespace and is published on
   * the host's loopback only (compose.yaml).
   */
  host: string
  dbPath: string
  population: number
  workspaceRoot: string | null
  authFile: string | null
  serverUrl: string | null
  /** Built UI (`vite build` output) served from the same port as the API. */
  uiDir: string
  /** Open the default browser once listening. */
  open: boolean
  /** Accept docker-sandbox runs. The container image turns them off without Docker's socket. */
  dockerSandbox: boolean
  /** How docker runs reach their containers: `bridge` from the container image, else `loopback`. */
  dockerReach: DockerReach
  /**
   * Where connectors and their credentials are kept (owner-only files). Beside the workspaces, never under them,
   * and never in the database.
   */
  connectorsDir: string
  /**
   * `--data-dir`: one folder holding everything a dashboard keeps, so two dashboards (a Work and a
   * Personal profile, say) share nothing: the database, workspaces, connectors, the Claude setup
   * token and the OpenCode login. Null without the flag: the project's `runs/` folder, as before.
   */
  dataDir: string | null
  /** The stored Claude setup token; null for the default beside the working directory. */
  claudeTokenFile: string | null
  /**
   * The host OpenCode server's data folder (its `auth.json` and state), for a data dir; null to
   * leave it to OpenCode's default or the OpenCode 2 credential bridge.
   */
  opencodeDataHome: string | null
  /**
   * Whether Claude agents may fall back to this machine's own `claude auth login` when no setup
   * token is stored. Off for a data dir: that login belongs to whichever account the machine is
   * signed in to, not to the profile.
   */
  hostClaudeLogin: boolean
}

/**
 * Where OpenCode keeps its credentials, if they exist.
 *
 * OpenCode resolves its data directory through XDG, falling back to
 * `~/.local/share` on every platform — Windows included — so that is where `opencode auth
 * login` writes `auth.json`. Only an existing file is returned: a path to nothing would
 * pass the spec's "authFile is set" check and then mount an empty credential into every
 * container, failing each agent on its first model call instead of refusing the run.
 */
export function defaultAuthFile(
  env: NodeJS.ProcessEnv,
  home: string,
  exists: (path: string) => boolean,
): string | null {
  const dataHome = env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0
    ? env.XDG_DATA_HOME
    : join(home, '.local', 'share')
  const candidate = join(dataHome, 'opencode', 'auth.json')
  return exists(candidate) ? candidate : null
}

/**
 * Turns `npm start`'s arguments into a runnable configuration, with defaults that make
 * starting the app a single command.
 *
 * The dashboard used to need an in-memory database (so every run vanished on restart),
 * an explicit workspace root, and a hand-typed credential path before a local or docker
 * run would even validate. Every one of those has an obvious answer on the machine the
 * app is running on, so they are the defaults now. Each flag still overrides its default,
 * and `--db :memory:` is still there for a throwaway session.
 *
 * Pure — the environment, home directory and file check are passed in — so the defaults
 * are tested directly rather than by starting a server.
 */
export function resolveStartOptions(input: {
  argv: string[]
  env: NodeJS.ProcessEnv
  projectRoot: string
  home: string
  exists: (path: string) => boolean
}): StartOptions {
  const { values } = parseArgs({
    args: input.argv,
    strict: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      db: { type: 'string' },
      population: { type: 'string' },
      'workspace-root': { type: 'string' },
      'auth-file': { type: 'string' },
      'server-url': { type: 'string' },
      'no-open': { type: 'boolean' },
      'no-docker-sandbox': { type: 'boolean' },
      'docker-reach': { type: 'string' },
      'connectors-dir': { type: 'string' },
      'data-dir': { type: 'string' },
    },
  })

  const port = Number(values.port ?? '4300')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port must be a whole number from 1 to 65535, got "${values.port}"`)
  }
  const population = Number(values.population ?? '8')
  if (!Number.isInteger(population) || population < 1) {
    throw new Error(`--population must be a whole number of at least 1, got "${values.population}"`)
  }

  const host = values.host ?? '127.0.0.1'
  if (host.length === 0) throw new Error('--host must not be empty')
  const dockerReach = values['docker-reach'] ?? 'loopback'
  if (dockerReach !== 'loopback' && dockerReach !== 'bridge') {
    throw new Error(`--docker-reach must be loopback or bridge, got "${dockerReach}"`)
  }

  // Relative to the project folder, like the other defaults: a shortcut may start the app elsewhere.
  const rawDataDir = values['data-dir']
  if (rawDataDir !== undefined && rawDataDir.trim() === '') throw new Error('--data-dir must not be empty')
  const dataDir = rawDataDir === undefined ? null : isAbsolute(rawDataDir) ? rawDataDir : join(input.projectRoot, rawDataDir)
  const runsDir = dataDir ?? join(input.projectRoot, 'runs')
  const opencodeDataHome = dataDir === null ? null : join(dataDir, 'secrets', 'opencode')
  return {
    port,
    host,
    population,
    dbPath: values.db ?? join(runsDir, 'dashboard.db'),
    // Absolute by construction, which run-spec validation requires.
    workspaceRoot: values['workspace-root'] ?? join(runsDir, 'workspaces'),
    // A data dir uses only its own OpenCode login, never the machine's.
    authFile: values['auth-file'] ?? (opencodeDataHome === null
      ? defaultAuthFile(input.env, input.home, input.exists)
      : defaultAuthFile({ XDG_DATA_HOME: opencodeDataHome }, input.home, input.exists)),
    serverUrl: values['server-url'] ?? null,
    uiDir: join(input.projectRoot, 'dist'),
    open: values['no-open'] !== true,
    dockerSandbox: values['no-docker-sandbox'] !== true,
    dockerReach,
    connectorsDir: values['connectors-dir'] ?? join(runsDir, 'connectors'),
    dataDir,
    claudeTokenFile: dataDir === null ? null : join(dataDir, 'secrets', 'claude-subscription.json'),
    opencodeDataHome,
    hostClaudeLogin: dataDir === null,
  }
}
