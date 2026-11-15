import { randomBytes } from 'node:crypto'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { ConnectorStore } from './store.js'

/** Thrown when a remote MCP server needs the operator to sign in from the dashboard first. */
export class NeedsSignInError extends Error {
  constructor(title: string) {
    super(`${title} needs you to sign in: open Connectors and choose Connect.`)
    this.name = 'NeedsSignInError'
  }
}

/**
 * The SDK's MCP OAuth client state for one connector, kept in the secrets file: dynamic client registration, PKCE
 * verifier, tokens and discovery. With `onRedirect` it drives the dashboard's browser step; without it (a run or a
 * connection test) a needed sign-in fails with NeedsSignInError instead of opening anything.
 */
export class StoredMcpOAuthProvider implements OAuthClientProvider {
  private readonly stateValue = randomBytes(24).toString('base64url')

  constructor(
    private readonly store: ConnectorStore,
    private readonly connectorId: string,
    private readonly opts: { title: string; redirectUrl?: string; state?: string; onRedirect?: (url: URL) => void },
  ) {}

  private oauth() {
    return this.store.secrets(this.connectorId).mcpOauth ?? {}
  }

  private save(change: (current: NonNullable<ReturnType<StoredMcpOAuthProvider['oauth']>>) => ReturnType<StoredMcpOAuthProvider['oauth']>): void {
    this.store.setSecrets(this.connectorId, (s) => ({ ...s, mcpOauth: change(s.mcpOauth ?? {}) }))
  }

  /** The redirect this client registered with, or the dashboard's callback for a new sign-in. */
  get redirectUrl(): string | undefined {
    if (this.opts.redirectUrl) return this.opts.redirectUrl
    const uris = (this.oauth().clientInformation as { redirect_uris?: unknown } | undefined)?.redirect_uris
    return Array.isArray(uris) && typeof uris[0] === 'string' ? uris[0] : 'http://127.0.0.1/api/connectors/oauth/callback'
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Agent Tournament',
      redirect_uris: [this.redirectUrl!],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  state(): string {
    return this.opts.state ?? this.stateValue
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const info = this.oauth().clientInformation as (OAuthClientInformationMixed & { redirect_uris?: string[] }) | undefined
    // A registration for another callback cannot complete this sign-in; register again.
    if (info && this.opts.redirectUrl && Array.isArray(info.redirect_uris) && !info.redirect_uris.includes(this.opts.redirectUrl)) return undefined
    return info
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.save((o) => ({ ...o, clientInformation: info as unknown as Record<string, unknown> }))
  }

  tokens(): OAuthTokens | undefined {
    return this.oauth().tokens as OAuthTokens | undefined
  }

  saveTokens(tokens: OAuthTokens): void {
    this.save((o) => ({ ...o, tokens: tokens as unknown as Record<string, unknown> }))
  }

  redirectToAuthorization(url: URL): void {
    if (!this.opts.onRedirect) throw new NeedsSignInError(this.opts.title)
    this.opts.onRedirect(url)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.save((o) => ({ ...o, codeVerifier }))
  }

  codeVerifier(): string {
    const verifier = this.oauth().codeVerifier
    if (!verifier) throw new NeedsSignInError(this.opts.title)
    return verifier
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    this.save((o) => {
      if (scope === 'all') return {}
      const next = { ...o }
      if (scope === 'client') delete next.clientInformation
      if (scope === 'tokens') delete next.tokens
      if (scope === 'verifier') delete next.codeVerifier
      if (scope === 'discovery') delete next.discovery
      return next
    })
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.save((o) => ({ ...o, discovery: state as unknown as Record<string, unknown> }))
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.oauth().discovery as OAuthDiscoveryState | undefined
  }
}
