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
