import { join } from 'node:path'
import { parseArgs } from 'node:util'

export interface StartOptions {
  port: number
  dbPath: string
  population: number
  workspaceRoot: string | null
  authFile: string | null
  serverUrl: string | null
  /** Built UI (`vite build` output) served from the same port as the API. */
  uiDir: string
  /** Open the default browser once listening. */
  open: boolean
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
      db: { type: 'string' },
      population: { type: 'string' },
      'workspace-root': { type: 'string' },
      'auth-file': { type: 'string' },
      'server-url': { type: 'string' },
      'no-open': { type: 'boolean' },
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

  const runsDir = join(input.projectRoot, 'runs')
  return {
    port,
    population,
    dbPath: values.db ?? join(runsDir, 'dashboard.db'),
    // Absolute by construction, which run-spec validation requires.
    workspaceRoot: values['workspace-root'] ?? join(runsDir, 'workspaces'),
    authFile: values['auth-file'] ?? defaultAuthFile(input.env, input.home, input.exists),
    serverUrl: values['server-url'] ?? null,
    uiDir: join(input.projectRoot, 'dist'),
    open: values['no-open'] !== true,
  }
}
