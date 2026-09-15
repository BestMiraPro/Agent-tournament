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

/** Whether the runtime lists any model at all for this provider. */
export function hasProvider(catalog: RuntimeCatalog, providerId: string): boolean {
  const prefix = `${providerId}/`
  for (const id of catalog.models) if (id.startsWith(prefix)) return true
  return false
}

/** The provider part of a model id: everything before the first slash. */
export function providerOf(modelId: string): string {
  const slash = modelId.indexOf('/')
  return slash < 0 ? modelId : modelId.slice(0, slash)
}

/**
 * Why a shard cannot run a model.
 *
 * OpenCode leaves a provider out of its catalogue entirely when it has no credentials for it,
 * so a whole missing provider means the container never received a key — the September 14
 * run mounted a folder as its auth file — not that the provider lacks that model.
 */
export function modelUnavailableMessage(modelId: string, version: string | null, shardIndex: number, providerMissing = false): string {
  const runtime = version ? `OpenCode ${version}` : 'OpenCode version unknown'
  if (providerMissing) {
    return `Provider unavailable in Docker runtime (${runtime}, shard ${shardIndex}): no credentials for "${providerOf(modelId)}" reached the container, ` +
      `so ${modelId} cannot run. Check the Credentials file setting (leave it blank to use your OpenCode login)`
  }
  return `Model unavailable in Docker runtime (${runtime}, shard ${shardIndex}): ${modelId} is not in its model catalogue`
}
