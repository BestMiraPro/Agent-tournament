import { GMAIL_READONLY_SCOPE } from '../presets.js'

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** The authorization URL for the operator's own desktop-app client: code + PKCE, gmail.readonly only, offline. */
export function googleAuthUrl(opts: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: GMAIL_READONLY_SCOPE,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    state: opts.state,
    access_type: 'offline',
    // A refresh token is only returned on consent; without this, re-connecting returns none.
    prompt: 'consent',
  })
  return `${GOOGLE_AUTH_URL}?${params}`
}

export interface GoogleTokens {
  accessToken: string
  expiresAt: number
  refreshToken?: string
  scope: string
}

/**
 * Refuses any grant wider than gmail.readonly. Google reports the granted scopes in `scope`; one that adds anything is
 * not stored, whatever the client was configured to ask for.
 */
export function assertReadonlyScope(scope: unknown): string {
  const granted = typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : []
  if (granted.length === 0 || granted.some((s) => s !== GMAIL_READONLY_SCOPE)) {
    throw new Error(`Google granted scopes other than ${GMAIL_READONLY_SCOPE}; nothing was stored. Remove the extra scopes from the client's consent screen and connect again.`)
  }
  return GMAIL_READONLY_SCOPE
}

async function tokenRequest(body: URLSearchParams, doFetch: typeof fetch, now: number): Promise<GoogleTokens> {
  const res = await doFetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || typeof json.access_token !== 'string') {
    // `error` is an OAuth error code (`invalid_grant`), safe to repeat; descriptions are not repeated.
    throw new Error(`Google refused the token request${typeof json.error === 'string' ? ` (${json.error.slice(0, 60)})` : ''}`)
  }
  const scope = assertReadonlyScope(json.scope)
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600
  return {
    accessToken: json.access_token,
    expiresAt: now + expiresIn * 1000,
    ...(typeof json.refresh_token === 'string' ? { refreshToken: json.refresh_token } : {}),
    scope,
  }
}

export function exchangeGoogleCode(opts: {
  clientId: string; clientSecret: string; code: string; codeVerifier: string; redirectUri: string
  fetch?: typeof fetch; now?: () => number
}): Promise<GoogleTokens> {
  return tokenRequest(new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    code_verifier: opts.codeVerifier,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
  }), opts.fetch ?? fetch, (opts.now ?? Date.now)())
}

export function refreshGoogleToken(opts: {
  clientId: string; clientSecret: string; refreshToken: string; fetch?: typeof fetch; now?: () => number
}): Promise<GoogleTokens> {
  return tokenRequest(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  }), opts.fetch ?? fetch, (opts.now ?? Date.now)())
}

/** A cached access token, refreshed host-side a minute before it expires. Concurrent callers share one refresh. */
export function googleAccessTokens(refresh: () => Promise<GoogleTokens>, now: () => number = Date.now): () => Promise<string> {
  let current: GoogleTokens | null = null
  let pending: Promise<GoogleTokens> | null = null
  return async () => {
    if (current && current.expiresAt - 60_000 > now()) return current.accessToken
    pending ??= refresh().finally(() => { pending = null })
    current = await pending
    return current.accessToken
  }
}
