import { RelayPolicy } from './provider-relay.js'
import { startProviderRelay, type ProviderRelay } from './provider-relay-server.js'

let shared: Promise<{ policy: RelayPolicy; relay: ProviderRelay }> | null = null
let sharedHost: string | null = null

/**
 * The one provider relay in this process, started on first use and shared by every protected run:
 * each run holds its own grant (token, roster models, keys), revoked when the run is disposed.
 * Loopback unless `host` names another address — the app's own bridge address when it runs in a
 * container — and the first start fixes it for the process. It never keeps the process alive by
 * itself. A failed start is retried on the next call rather than remembered.
 */
export function processRelay(opts: { host?: string } = {}): Promise<{ policy: RelayPolicy; port: number; host: string }> {
  const host = opts.host ?? '127.0.0.1'
  if (shared && sharedHost !== host) {
    return Promise.reject(new Error(`The provider relay already listens on ${sharedHost}, not ${host}`))
  }
  if (!shared) {
    const starting = (async () => {
      const policy = new RelayPolicy()
      const relay = await startProviderRelay({ policy, host, unref: true })
      return { policy, relay }
    })()
    shared = starting
    sharedHost = host
    starting.catch(() => {
      if (shared === starting) shared = null
    })
  }
  return shared.then(({ policy, relay }) => ({ policy, port: relay.port, host: relay.host }))
}

export async function closeProcessRelay(): Promise<void> {
  const current = shared
  shared = null
  sharedHost = null
  if (current) await (await current).relay.close()
}
