const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/

/**
 * The OpenCode config a protected worker runs with: every roster provider's base URL points at
 * the relay on the shard's own network, and the run token stands where an API key would be.
 * No real credential is in it, so it is safe to mount where the agent can read it.
 *
 * Verified against opencode 1.18.21 with no credentials file (September 15 2026): providers
 * configured this way are listed, and a prompt reaches the configured base URL carrying the
 * token as its bearer credential.
 */
export function relayProviderConfig(opts: { providers: readonly string[]; relayBaseUrl: string; token: string }): string {
  let url: URL
  try {
    url = new URL(opts.relayBaseUrl)
  } catch {
    throw new Error(`relay URL must look like http://gateway:8787, got ${JSON.stringify(opts.relayBaseUrl)}`)
  }
  // Plain http on the private shard network; TLS is the relay's job on its way upstream.
  if (url.protocol !== 'http:' || url.pathname !== '/' || opts.relayBaseUrl.endsWith('/') || url.search || url.hash || url.username) {
    throw new Error(`relay URL must look like http://gateway:8787, got ${JSON.stringify(opts.relayBaseUrl)}`)
  }
  const providers = [...new Set(opts.providers)].sort()
  for (const id of providers) {
    if (!PROVIDER_ID.test(id)) throw new Error(`provider id ${JSON.stringify(id)} is not a plain provider id`)
  }
  const provider: Record<string, { options: { baseURL: string; apiKey: string } }> = {}
  for (const id of providers) provider[id] = { options: { baseURL: `${opts.relayBaseUrl}/${id}`, apiKey: opts.token } }
  return JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider }, null, 2)
}
