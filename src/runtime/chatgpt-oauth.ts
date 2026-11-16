import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * OpenCode's ChatGPT Plus/Pro login, as opencode 1.18.21 stores and uses it (read from its binary,
 * docs/superpowers/specs/2026-11-15-subscription-runs-design.md): an `openai` entry of type `oauth`
 * in `auth.json`, refreshed against the OpenAI issuer with the Codex client id, and sent to the
 * ChatGPT Codex backend with the account id.
 */
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CHATGPT_ISSUER = 'https://auth.openai.com'
export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

/** Refresh this long before expiry, so the host OpenCode (which waits for expiry) finds a fresh token. */
const REFRESH_SKEW_MS = 120_000
const LOCK_STALE_MS = 60_000
const LOCK_WAIT_MS = 30_000

export const CHATGPT_REAUTH_MESSAGE =
  'ChatGPT sign-in expired or was revoked: run `opencode auth login`, choose OpenAI → ChatGPT Plus/Pro, then start the round again.'

export interface ChatGptOAuth {
  type: 'oauth'
  refresh: string
  access: string
  /** Milliseconds since the epoch. */
  expires: number
  accountId?: string
}

/** The stored login can no longer be refreshed; signing in again is the only fix. */
export class ChatGptReauthRequired extends Error {
  constructor(message = CHATGPT_REAUTH_MESSAGE) {
    super(message)
    this.name = 'ChatGptReauthRequired'
  }
}

/** The subscription's usage limit; the login is fine and signing in again would not help. */
export class ChatGptRateLimited extends Error {
  constructor(readonly resetAt: number) {
    super(`ChatGPT subscription usage limit reached; it resets at ${new Date(resetAt).toISOString()}. The sign-in is still valid.`)
    this.name = 'ChatGptRateLimited'
  }
}

/** The `openai` OAuth entry of a parsed credentials file, or null when there is none. */
export function chatGptLoginOf(auth: unknown): ChatGptOAuth | null {
  const entry = auth && typeof auth === 'object' ? (auth as Record<string, unknown>).openai : undefined
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  if (e.type !== 'oauth' || typeof e.refresh !== 'string' || e.refresh.length === 0) return null
  return {
    type: 'oauth',
    refresh: e.refresh,
    access: typeof e.access === 'string' ? e.access : '',
    expires: typeof e.expires === 'number' && Number.isFinite(e.expires) ? e.expires : 0,
    ...(typeof e.accountId === 'string' && e.accountId.length > 0 ? { accountId: e.accountId } : {}),
  }
}

export interface ChatGptLoginStatus {
  signedIn: boolean
  /** The access token has expired; OpenCode or the relay refreshes it on the next call. */
  expired: boolean
  expiresAt: number | null
}

/** What the dashboard may say about the login: never a token. */
export function chatGptLoginStatus(authJson: string | null, now: number = Date.now()): ChatGptLoginStatus {
  if (authJson === null) return { signedIn: false, expired: false, expiresAt: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(authJson)
  } catch {
    return { signedIn: false, expired: false, expiresAt: null }
  }
  const login = chatGptLoginOf(parsed)
  if (!login) return { signedIn: false, expired: false, expiresAt: null }
  return { signedIn: true, expired: login.expires <= now, expiresAt: login.expires || null }
}

function jwtClaims(token: string | undefined): Record<string, unknown> | null {
  const part = token?.split('.')[1]
  if (!part) return null
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown
    return claims && typeof claims === 'object' ? claims as Record<string, unknown> : null
  } catch {
    return null
  }
}

function accountIdOfClaims(claims: Record<string, unknown> | null): string | undefined {
  if (!claims) return undefined
  const auth = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined
  const orgs = claims.organizations as { id?: unknown }[] | undefined
  const id = claims.chatgpt_account_id ?? auth?.chatgpt_account_id ?? orgs?.[0]?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** The ChatGPT account id, from the id token first and then the access token, as OpenCode reads it. */
export function accountIdFromTokens(tokens: { id_token?: string; access_token?: string }): string | undefined {
  return accountIdOfClaims(jwtClaims(tokens.id_token)) ?? accountIdOfClaims(jwtClaims(tokens.access_token))
}

/** The compute residency the Codex backend expects back as a header, unless unconstrained. */
export function residencyOf(access: string): string | undefined {
  const claims = jwtClaims(access)
  const auth = claims?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined
  const value = auth?.chatgpt_compute_residency ?? claims?.chatgpt_compute_residency
  return typeof value === 'string' && value !== 'no_constraint' && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : undefined
}

export type TokenFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) =>
  Promise<{ status: number; json(): Promise<unknown> }>

const REAUTH_CODES = new Set(['invalid_grant', 'invalid_token', 'refresh_token_reused', 'refresh_token_expired', 'refresh_token_invalidated', 'invalid_client'])

/**
 * The relay's view of one ChatGPT login. Every call re-reads `auth.json`, so a token the host
 * OpenCode refreshed is adopted rather than refreshed again. A refresh happens at most once at a
 * time: under an in-process promise and a lock file beside `auth.json`, after re-reading it, and
 * the rotated pair is written back atomically (temp file and rename, mode 0600, other providers
 * untouched) before it is used. A refused refresh first checks whether OpenCode rotated the login
 * meanwhile; if not, it is final until the file changes, so a retry loop cannot hammer the issuer.
 */
export class ChatGptLogin {
  private inflight: Promise<ChatGptOAuth> | null = null
  /** The refresh token the issuer refused; requests with it fail at once. */
  private refused: string | null = null
  /** A rotated login whose write-back failed: kept so the rotated refresh token is never lost. */
  private memo: ChatGptOAuth | null = null

  constructor(private opts: {
    authFile: string
    fetch?: TokenFetch
    now?: () => number
    onWarning?: (message: string) => void
  }) {}

  private limitUntil = 0

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  /** While the subscription's usage limit holds: the refusal to send instead of calling upstream. */
  limited(): ChatGptRateLimited | null {
    return this.now() < this.limitUntil ? new ChatGptRateLimited(this.limitUntil) : null
  }

  noteLimit(resetAt: number): void {
    this.limitUntil = Math.max(this.limitUntil, resetAt)
  }

  async credentials(): Promise<{ access: string; accountId?: string }> {
    let entry = await this.readEntry()
    if (this.memo && (!entry || this.memo.expires > entry.expires)) entry = this.memo
    if (!entry) throw new ChatGptReauthRequired('There is no ChatGPT Plus/Pro login in the credentials file: run `opencode auth login`, choose OpenAI → ChatGPT Plus/Pro.')
    if (this.fresh(entry)) return publicOf(entry)
    if (this.refused !== null && entry.refresh === this.refused) throw new ChatGptReauthRequired()
    this.inflight ??= this.refresh().finally(() => { this.inflight = null })
    return publicOf(await this.inflight)
  }

  private fresh(entry: ChatGptOAuth): boolean {
    return entry.access.length > 0 && entry.expires - this.now() > REFRESH_SKEW_MS
  }

  private async readEntry(): Promise<ChatGptOAuth | null> {
    try {
      return chatGptLoginOf(JSON.parse(await readFile(this.opts.authFile, 'utf8')))
    } catch {
      return null
    }
  }

  private async refresh(): Promise<ChatGptOAuth> {
    // Refreshing rotates the refresh token. Where the rotated one cannot be saved, refreshing would
    // strand the host's own OpenCode with a dead token, so it is refused instead.
    if (!(await this.writable())) {
      throw new ChatGptReauthRequired(
        'The ChatGPT access token has expired and the credentials file is read-only here, so it cannot be refreshed without ' +
          'losing the rotated token. Run any OpenCode command on the host (it refreshes the login), or make the file writable.',
      )
    }
    const release = await this.lock()
    try {
      let current = await this.readEntry()
      if (this.memo && (!current || this.memo.expires > current.expires)) current = this.memo
      if (!current) throw new ChatGptReauthRequired()
      if (this.fresh(current)) return current
      let tokens: { access_token: string; refresh_token?: string; expires_in?: number; id_token?: string }
      try {
        tokens = await this.requestRefresh(current.refresh)
      } catch (e) {
        if (e instanceof ChatGptReauthRequired) {
          const after = await this.readEntry()
          if (after && after.refresh !== current.refresh && this.fresh(after)) return after
          this.refused = current.refresh
        }
        throw e
      }
      const next: ChatGptOAuth = {
        type: 'oauth',
        refresh: tokens.refresh_token ?? current.refresh,
        access: tokens.access_token,
        expires: this.now() + (tokens.expires_in ?? 3600) * 1000,
        ...((accountIdFromTokens(tokens) ?? current.accountId) ? { accountId: accountIdFromTokens(tokens) ?? current.accountId } : {}),
      }
      try {
        await this.writeEntry(next)
        this.memo = null
      } catch (e) {
        this.memo = next
        this.opts.onWarning?.(`Could not save the refreshed ChatGPT login to ${this.opts.authFile} (${(e as NodeJS.ErrnoException).code ?? 'write failed'}); it is kept in memory for this process.`)
      }
      return next
    } finally {
      await release()
    }
  }

  private async requestRefresh(refreshToken: string) {
    const doFetch = this.opts.fetch ?? (globalThis.fetch as unknown as TokenFetch)
    let res: { status: number; json(): Promise<unknown> }
    try {
      res = await doFetch(`${CHATGPT_ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CHATGPT_CLIENT_ID }).toString(),
      })
    } catch {
      throw new Error('ChatGPT token refresh failed: the OpenAI sign-in service was unreachable.')
    }
    let body: Record<string, unknown> = {}
    try {
      const parsed = await res.json()
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
    } catch {
      /* the status decides */
    }
    if (res.status === 429) throw new ChatGptRateLimited(this.now() + 60_000)
    const error = body.error
    const code = typeof error === 'string' ? error : typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : ''
    if (res.status === 400 || res.status === 401 || res.status === 403 || REAUTH_CODES.has(code)) throw new ChatGptReauthRequired()
    if (res.status < 200 || res.status >= 300 || typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new Error(`ChatGPT token refresh failed (HTTP ${res.status}).`)
    }
    return body as { access_token: string; refresh_token?: string; expires_in?: number; id_token?: string }
  }

  private async writable(): Promise<boolean> {
    try {
      await access(this.opts.authFile, constants.W_OK)
      await access(dirname(this.opts.authFile), constants.W_OK)
      return true
    } catch {
      return false
    }
  }

  /** Writes the login back: everything else in the file is re-read now and kept as it is. */
  private async writeEntry(next: ChatGptOAuth): Promise<void> {
    const raw = JSON.parse(await readFile(this.opts.authFile, 'utf8')) as Record<string, unknown>
    raw.openai = next
    const temp = join(dirname(this.opts.authFile), `.${basename(this.opts.authFile)}.${randomBytes(6).toString('hex')}.tmp`)
    await writeFile(temp, JSON.stringify(raw, null, 2), { mode: 0o600, flag: 'wx' })
    try {
      await rename(temp, this.opts.authFile)
    } catch (e) {
      await rm(temp, { force: true }).catch(() => {})
      throw e
    }
  }

  private async lock(): Promise<() => Promise<void>> {
    const path = `${this.opts.authFile}.arena-refresh.lock`
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        const handle = await open(path, 'wx', 0o600)
        await handle.writeFile(`${process.pid} ${this.now()}\n`)
        await handle.close()
        return async () => { await rm(path, { force: true }).catch(() => {}) }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        const info = await stat(path).catch(() => null)
        if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(path, { force: true }).catch(() => {})
          continue
        }
        if (Date.now() > deadline) throw new Error('Another process has been refreshing the ChatGPT login for too long; try again shortly.')
        await new Promise((r) => setTimeout(r, 100))
      }
    }
  }
}

function publicOf(entry: ChatGptOAuth): { access: string; accountId?: string } {
  return { access: entry.access, ...(entry.accountId ? { accountId: entry.accountId } : {}) }
}

const logins = new Map<string, ChatGptLogin>()

/**
 * One login per credentials file in this process, so every protected run on the same file shares
 * its refresh lock, its memory of a rotated token and its usage-limit state.
 */
export function chatGptLoginFor(authFile: string, onWarning?: (message: string) => void): ChatGptLogin {
  let login = logins.get(authFile)
  if (!login) {
    login = new ChatGptLogin({ authFile, ...(onWarning ? { onWarning } : {}) })
    logins.set(authFile, login)
  }
  return login
}
