import { RelayPolicy } from './provider-relay.js'
import { startProviderRelay, type ProviderRelay } from './provider-relay-server.js'

let shared: Promise<{ policy: RelayPolicy; relay: ProviderRelay }> | null = null

/**
 * The one provider relay in this process, started on first use and shared by every protected run:
 * each run holds its own grant (token, roster models, keys), revoked when the run is disposed.
 * Loopback only, and it never keeps the process alive by itself. A failed start is retried on the
 * next call rather than remembered.
 */
export function processRelay(): Promise<{ policy: RelayPolicy; port: number }> {
  if (!shared) {
    const starting = (async () => {
      const policy = new RelayPolicy()
      const relay = await startProviderRelay({ policy, unref: true })
      return { policy, relay }
    })()
    shared = starting
    starting.catch(() => {
      if (shared === starting) shared = null
    })
  }
  return shared.then(({ policy, relay }) => ({ policy, port: relay.port }))
}

export async function closeProcessRelay(): Promise<void> {
  const current = shared
  shared = null
  if (current) await (await current).relay.close()
}
