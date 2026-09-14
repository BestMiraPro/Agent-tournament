import { join } from 'node:path'
import type { OpenCodeClient, ProvidersResponse } from './client.js'

/** Turns the provider map into fully qualified `provider/model` ids. */
export function flattenProviders(res: ProvidersResponse): string[] {
  const out: string[] = []
  for (const p of res.providers ?? []) {
    for (const modelId of Object.keys(p.models ?? {})) {
      out.push(`${p.id}/${modelId}`)
    }
  }
  return out
}

export async function discoverModels(client: OpenCodeClient): Promise<string[]> {
  return flattenProviders(await client.providers())
}

/**
 * The host's models.dev catalogue, if OpenCode has cached one.
 *
 * OpenCode resolves its cache directory through XDG, falling back to `~/.cache` on every
 * platform, Windows included. This one public catalogue file is the only piece of host
 * OpenCode state shared with shards besides credentials: it carries no secrets, and it is
 * what the host's model validation actually resolved against.
 */
export function hostModelsCatalog(
  env: NodeJS.ProcessEnv,
  home: string,
  exists: (path: string) => boolean,
): string | null {
  const cacheHome = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0
    ? env.XDG_CACHE_HOME
    : join(home, '.cache')
  const candidate = join(cacheHome, 'opencode', 'models.json')
  return exists(candidate) ? candidate : null
}

/** What one OpenCode runtime can actually resolve, read without generating anything. */
export interface RuntimeCatalog {
  version: string | null
  /** Fully qualified `provider/model` ids, exactly as a request would name them. */
  models: ReadonlySet<string>
}

/**
 * Reads a runtime's catalogue. Proves a model id resolves there — not that credentials,
 * tools or inference work; those still fail, visibly, on the agent's own request.
 */
export async function readRuntimeCatalog(
  client: Pick<OpenCodeClient, 'providers' | 'version'>,
): Promise<RuntimeCatalog> {
  const [providers, version] = await Promise.all([client.providers(), client.version()])
  return { version, models: new Set(flattenProviders(providers)) }
}

/**
 * Selected ids the runtime does not list, de-duplicated, in first-seen order.
 *
 * Exact full-id comparison only. OpenCode's "did you mean" suggestion for a missing
 * `wandb/deepseek-ai/...` model is the prefix-less key, and treating that as a match would
 * be exactly the silent provider stripping `splitModelId` exists to prevent.
 */
export function missingModels(catalog: RuntimeCatalog, modelIds: readonly string[]): string[] {
  return [...new Set(modelIds)].filter((id) => !catalog.models.has(id))
}

export function modelUnavailableMessage(modelId: string, version: string | null, shardIndex: number): string {
  const runtime = version ? `OpenCode ${version}` : 'OpenCode version unknown'
  return `Model unavailable in Docker runtime (${runtime}, shard ${shardIndex}): ${modelId} is not in its model catalogue`
}
