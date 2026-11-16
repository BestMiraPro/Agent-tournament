import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { ClaudeCredentials } from './env.js'
import { strippedEnv } from './env.js'

/** `claude setup-token` values are opaque but printable; a terminal-wrapped paste is rejoined first. */
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{20,4096}$/

export function normalizeClaudeToken(raw: string): string {
  return raw.replace(/\s+/g, '')
}

export function validClaudeToken(token: string): boolean {
  return TOKEN_RE.test(token)
}

/**
 * The `claude setup-token` value, kept on this host in one small file: mode 0600 in a 0700 folder,
 * written atomically. It is never stored in the database, exported, logged, put in an event or
 * passed on a command line; status calls report only whether it is set.
 */
export class ClaudeTokenStore {
  constructor(readonly file: string) {}

  async read(): Promise<string | null> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(text) as { token?: unknown }
      return typeof parsed.token === 'string' && validClaudeToken(parsed.token) ? parsed.token : null
    } catch {
      return null
    }
  }

  async has(): Promise<boolean> {
    return (await this.read()) !== null
  }

  /** Stores a pasted token; throws a fixed message (never echoing the value) when it is not one. */
  async set(raw: string): Promise<void> {
    const token = normalizeClaudeToken(raw)
    if (!validClaudeToken(token)) {
      throw new Error('That does not look like a `claude setup-token` value: paste the whole token it printed.')
    }
    const dir = dirname(this.file)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700).catch(() => {})
    const temp = join(dir, `.claude-subscription-${randomBytes(6).toString('hex')}.tmp`)
    await writeFile(temp, `${JSON.stringify({ version: 1, token })}\n`, { mode: 0o600, flag: 'wx' })
    try {
      await rename(temp, this.file)
    } catch (e) {
      await rm(temp, { force: true }).catch(() => {})
      throw e
    }
    await chmod(this.file, 0o600).catch(() => {})
  }

  async clear(): Promise<boolean> {
    const existed = existsSync(this.file)
    await rm(this.file, { force: true })
    return existed
  }
}

/**
 * The Claude Code CLI on this host: `CLAUDE_CLI_PATH` when set, else `claude` on PATH, else the
 * installer's usual places. Null when none is found.
 */
export function findClaudeCli(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  isFile: (path: string) => boolean = defaultIsFile,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const configured = env.CLAUDE_CLI_PATH?.trim()
  if (configured) return isFile(configured) ? configured : null
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude']
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (isFile(candidate)) return candidate
    }
  }
  for (const candidate of [
    join(home, '.local', 'bin', platform === 'win32' ? 'claude.exe' : 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]) {
    if (isFile(candidate)) return candidate
  }
  return null
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export type ExecText = (file: string, args: string[], opts: { env: Record<string, string>; cwd: string; timeoutMs: number }) =>
  Promise<{ code: number; stdout: string }>

export const execText: ExecText = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout ?? '') })
    })
  })

/** The CLI's own version line (`2.1.325 (Claude Code)`), or null. */
export async function claudeCliVersion(cli: string, exec: ExecText = execText): Promise<string | null> {
  const r = await exec(cli, ['--version'], { env: strippedEnv(process.env), cwd: tmpdir(), timeoutMs: 15_000 })
  const line = r.stdout.trim().split('\n')[0] ?? ''
  return r.code === 0 && /^[0-9][0-9A-Za-z .()+-]{0,79}$/.test(line) ? line : null
}

export interface HostLogin {
  loggedIn: boolean
  /** `claude.ai` for a subscription login; anything else is not a subscription. */
  authMethod: string | null
  subscriptionType: string | null
}

/**
 * Whether this machine's Claude Code is signed in to a subscription (`claude auth status --json`),
 * read with the same stripped environment the runner uses. Account details (email, organisation)
 * are never read out.
 */
export async function hostLoginStatus(cli: string, exec: ExecText = execText): Promise<HostLogin> {
  const r = await exec(cli, ['auth', 'status', '--json'], { env: strippedEnv(process.env), cwd: tmpdir(), timeoutMs: 20_000 })
  try {
    const data = JSON.parse(r.stdout) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9._ -]{1,40}$/.test(v) ? v : null)
    return { loggedIn: data.loggedIn === true, authMethod: str(data.authMethod), subscriptionType: str(data.subscriptionType) }
  } catch {
    return { loggedIn: false, authMethod: null, subscriptionType: null }
  }
}

export function isSubscriptionLogin(login: HostLogin): boolean {
  return login.loggedIn && login.authMethod === 'claude.ai'
}

/**
 * The credentials a Claude call uses: the stored token when there is one, else the host's own
 * subscription login. `allowHost` is false where the host login cannot reach (containers).
 */
export async function resolveClaudeCredentials(opts: {
  store: Pick<ClaudeTokenStore, 'read'>
  hostLogin: () => Promise<HostLogin>
  allowHost: boolean
}): Promise<ClaudeCredentials> {
  const token = await opts.store.read()
  if (token) return { mode: 'token', token }
  if (!opts.allowHost) {
    throw new Error(
      'Claude subscription agents in Docker need a `claude setup-token` value: run `claude setup-token` and paste it under Subscriptions. ' +
        "The machine's own Claude login is not available inside containers.",
    )
  }
  const login = await opts.hostLogin()
  if (isSubscriptionLogin(login)) return { mode: 'host' }
  throw new Error(
    'Claude subscription is not signed in: run `claude setup-token` and paste the token under Subscriptions, ' +
      'or sign this machine in with `claude auth login`.',
  )
}

/** Where the dashboard keeps the token unless told otherwise: under the gitignored `runs/` folder. */
export function defaultClaudeTokenFile(cwd: string = process.cwd()): string {
  return join(cwd, 'runs', 'secrets', 'claude-subscription.json')
}
