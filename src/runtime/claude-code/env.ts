/**
 * How the Claude Code CLI is authenticated for one call.
 *
 * - `token`: a long-lived token from `claude setup-token`.
 * - `host`: the machine's own Claude Code login (`claude auth login`); host processes only.
 * - `relay`: a protected worker. The CLI talks to the provider relay through the shard gateway and
 *   holds only the run's relay token, which the relay swaps for the real subscription token.
 */
export type ClaudeCredentials =
  | { mode: 'token'; token: string }
  | { mode: 'host' }
  | { mode: 'relay'; baseUrl: string; token: string }

/** The file descriptor a token is written to when it is not passed in the environment. */
export const TOKEN_FD = 3

/**
 * Inherited variables that would change which account or bill the CLI uses, or that belong to a
 * Claude Code session that launched this app: `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` silently
 * switch the CLI to API billing, `ANTHROPIC_BASE_URL` reroutes it (a desktop app sets one), the
 * `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY` switches change provider, and `CLAUDECODE`,
 * `CLAUDE_CODE_*` and `CLAUDE_AGENT_SDK_*` describe another session. All of them go; the runner
 * sets back only what it needs.
 */
export function isStrippedVariable(name: string): boolean {
  const upper = name.toUpperCase()
  return upper.startsWith('ANTHROPIC_') || upper.startsWith('CLAUDE')
}

/** `base` without any variable `isStrippedVariable` names, and without empty values. */
export function strippedEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || isStrippedVariable(key)) continue
    out[key] = value
  }
  return out
}

export interface ClaudeEnvOptions {
  credentials: ClaudeCredentials
  /**
   * `fd`: the token is written to descriptor 3 and never enters the environment (host processes).
   * `env`: it is a secret variable, which `docker exec -e NAME` takes from the client's environment.
   */
  tokenTransport: 'fd' | 'env'
  /** A private config directory: token and relay modes, so no host settings or history are used. */
  configDir?: string | null
  /** The agent's model; in relay mode every auxiliary call is pinned to it, so none leaves the roster. */
  model?: string
}

/**
 * The CLI's variables for one call, split by whether they may appear in a command line.
 * `settings` are safe anywhere; `secrets` hold a credential and must only travel in a process
 * environment.
 */
export function claudeEnvVars(opts: ClaudeEnvOptions): { settings: Record<string, string>; secrets: Record<string, string> } {
  const settings: Record<string, string> = {
    DISABLE_AUTOUPDATER: '1',
    // No telemetry, error reporting or update checks: nothing but model calls leaves the CLI.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Agents must not carry hidden notes between rounds, nor read the owner's own CLAUDE.md.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  }
  const secrets: Record<string, string> = {}
  if (opts.configDir) settings.CLAUDE_CONFIG_DIR = opts.configDir
  const c = opts.credentials
  if (c.mode === 'token') {
    if (opts.tokenTransport === 'fd') settings.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = String(TOKEN_FD)
    else secrets.CLAUDE_CODE_OAUTH_TOKEN = c.token
  } else if (c.mode === 'relay') {
    settings.ANTHROPIC_BASE_URL = c.baseUrl
    if (opts.model) {
      settings.ANTHROPIC_DEFAULT_HAIKU_MODEL = opts.model
      settings.ANTHROPIC_SMALL_FAST_MODEL = opts.model
    }
    secrets.CLAUDE_CODE_OAUTH_TOKEN = c.token
  }
  return { settings, secrets }
}

/** The full environment for a CLI the host spawns directly. */
export function claudeProcessEnv(base: NodeJS.ProcessEnv, opts: ClaudeEnvOptions): Record<string, string> {
  const { settings, secrets } = claudeEnvVars(opts)
  return { ...strippedEnv(base), ...settings, ...secrets }
}
