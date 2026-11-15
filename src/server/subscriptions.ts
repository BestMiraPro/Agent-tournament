import { readFile } from 'node:fs/promises'
import { chatGptLoginFor, chatGptLoginStatus, type ChatGptLogin } from '../runtime/chatgpt-oauth.js'
import {
  claudeCliVersion,
  ClaudeTokenStore,
  defaultClaudeTokenFile,
  findClaudeCli,
  hostLoginStatus,
  isSubscriptionLogin,
  type HostLogin,
} from '../runtime/claude-code/credentials.js'
import { claudeLimitGate, type SubscriptionLimitGate } from '../runtime/claude-code/limit-gate.js'
import { DEFAULT_CLAUDE_SUBSCRIPTION_MODELS } from '../runtime/claude-code/model-id.js'
import type { RateLimitReading } from '../runtime/claude-code/stream.js'

/** Everything the dashboard and run composition need to know about the two subscriptions. */
export interface SubscriptionServices {
  claudeTokens: Pick<ClaudeTokenStore, 'read' | 'has' | 'set' | 'clear'>
  findClaudeCli: () => string | null
  /** Cached briefly: each read starts a CLI process. */
  claudeHostLogin: () => Promise<HostLogin>
  claudeCliVersion: () => Promise<string | null>
  claudeLimitGate: SubscriptionLimitGate
  /** The relay's refreshing view of OpenCode's ChatGPT login in one credentials file. */
  chatGptLogin: (authFile: string) => ChatGptLogin
}

const HOST_LOGIN_TTL_MS = 30_000

export function subscriptionServices(opts: { tokenFile?: string } = {}): SubscriptionServices {
  const store = new ClaudeTokenStore(opts.tokenFile ?? defaultClaudeTokenFile())
  let login: { at: number; value: Promise<HostLogin> } | null = null
  let version: Promise<string | null> | null = null
  return {
    claudeTokens: store,
    findClaudeCli: () => findClaudeCli(),
    claudeHostLogin: () => {
      if (login && Date.now() - login.at < HOST_LOGIN_TTL_MS) return login.value
      const cli = findClaudeCli()
      const value = cli ? hostLoginStatus(cli) : Promise.resolve({ loggedIn: false, authMethod: null, subscriptionType: null })
      login = { at: Date.now(), value }
      return value
    },
    claudeCliVersion: () => {
      const cli = findClaudeCli()
      if (!cli) return Promise.resolve(null)
      version ??= claudeCliVersion(cli).then((v) => {
        if (v === null) version = null
        return v
      })
      return version
    },
    claudeLimitGate,
    chatGptLogin: (authFile) => chatGptLoginFor(authFile),
  }
}

export interface SubscriptionStatus {
  claude: {
    cli: { found: boolean; version: string | null }
    /** Whether a `claude setup-token` value is stored; never the value. */
    tokenSet: boolean
    /** Whether this machine's Claude Code is signed in to a subscription. */
    hostLogin: boolean
    /** What runs would use: the token, the host login, or nothing. */
    mode: 'token' | 'host' | null
    /** The latest rate-limit reading the CLI reported, if any. */
    usage: RateLimitReading | null
    models: string[]
  }
  chatgpt: {
    /** The credentials file read, when there is one. */
    credentialsFile: string | null
    signedIn: boolean
    expired: boolean
    expiresAt: number | null
    /** ChatGPT models are OpenCode's own `openai/*` models when this login is present. */
    modelPrefix: 'openai/'
  }
}

/** Sign-in state for both subscriptions, with no secret in it. */
export async function subscriptionStatus(services: SubscriptionServices, authFile: string | null): Promise<SubscriptionStatus> {
  const cliPath = services.findClaudeCli()
  const [tokenSet, login, version, authJson] = await Promise.all([
    services.claudeTokens.has(),
    cliPath ? services.claudeHostLogin().catch(() => null) : Promise.resolve(null),
    cliPath ? services.claudeCliVersion().catch(() => null) : Promise.resolve(null),
    authFile ? readFile(authFile, 'utf8').catch(() => null) : Promise.resolve(null),
  ])
  const hostLogin = login !== null && isSubscriptionLogin(login)
  const chat = chatGptLoginStatus(authJson)
  return {
    claude: {
      cli: { found: cliPath !== null, version },
      tokenSet,
      hostLogin,
      mode: tokenSet ? 'token' : hostLogin ? 'host' : null,
      usage: services.claudeLimitGate.last(),
      models: [...DEFAULT_CLAUDE_SUBSCRIPTION_MODELS],
    },
    chatgpt: { credentialsFile: authFile, ...chat, modelPrefix: 'openai/' },
  }
}
