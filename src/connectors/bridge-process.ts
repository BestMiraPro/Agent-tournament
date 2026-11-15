import { ToolBridge } from './bridge.js'
import { startToolBridgeServer, type ToolBridgeServer } from './bridge-server.js'

let shared: Promise<{ bridge: ToolBridge; server: ToolBridgeServer }> | null = null
let sharedHost: string | null = null

/**
 * The one tool bridge in this process, started on first use and shared by every run: each run holds its own grant,
 * revoked when the run is disposed. Loopback unless `host` names another address (the app's own bridge address when
 * it runs in a container); the first start fixes it for the process. It never keeps the process alive by itself, and
 * a failed start is retried on the next call rather than remembered. Mirrors the provider relay's process singleton.
 */
export function processToolBridge(opts: { host?: string } = {}): Promise<{ bridge: ToolBridge; port: number; host: string }> {
  const host = opts.host ?? '127.0.0.1'
  if (shared && sharedHost !== host) {
    return Promise.reject(new Error(`The tool bridge already listens on ${sharedHost}, not ${host}`))
  }
  if (!shared) {
    const starting = (async () => {
      const bridge = new ToolBridge()
      const server = await startToolBridgeServer({ bridge, host, unref: true })
      return { bridge, server }
    })()
    shared = starting
    sharedHost = host
    starting.catch(() => {
      if (shared === starting) shared = null
    })
  }
  return shared.then(({ bridge, server }) => ({ bridge, port: server.port, host: server.host }))
}

export async function closeProcessToolBridge(): Promise<void> {
  const current = shared
  shared = null
  sharedHost = null
  if (current) await (await current).server.close()
}
