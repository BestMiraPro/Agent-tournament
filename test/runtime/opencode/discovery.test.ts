import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  flattenProviders,
  hasProvider,
  hostModelsCatalog,
  missingModels,
  modelUnavailableMessage,
  readRuntimeCatalog,
} from '../../../src/runtime/opencode/discovery.js'
import { splitModelId } from '../../../src/runtime/opencode/model-id.js'

const RESPONSE = {
  providers: [
    { id: 'wandb', models: { 'deepseek-ai/DeepSeek-V4-Flash': {}, 'zai-org/GLM-5.2': {} } },
    { id: 'opencode', models: { 'big-pickle': {} } },
  ],
  default: { wandb: 'zai-org/GLM-5.2', opencode: 'big-pickle' },
}

describe('flattenProviders', () => {
  test('produces fully qualified model ids', () => {
    expect(flattenProviders(RESPONSE)).toEqual([
      'wandb/deepseek-ai/DeepSeek-V4-Flash',
      'wandb/zai-org/GLM-5.2',
      'opencode/big-pickle',
    ])
  })

  test('preserves multi-segment model ids intact', () => {
    expect(flattenProviders(RESPONSE)[0]).toBe('wandb/deepseek-ai/DeepSeek-V4-Flash')
  })

  test('handles a provider with no models', () => {
    expect(flattenProviders({ providers: [{ id: 'x', models: {} }], default: {} })).toEqual([])
  })

  test('handles an empty provider list', () => {
    expect(flattenProviders({ providers: [], default: {} })).toEqual([])
  })
})

describe('hostModelsCatalog', () => {
  test('is the OpenCode cache models.json under XDG_CACHE_HOME when it is set', () => {
    expect(hostModelsCatalog({ XDG_CACHE_HOME: '/xdg' }, '/home/u', () => true))
      .toBe(join('/xdg', 'opencode', 'models.json'))
  })

  test('falls back to ~/.cache, which OpenCode uses on every platform', () => {
    expect(hostModelsCatalog({}, '/home/u', () => true)).toBe(join('/home/u', '.cache', 'opencode', 'models.json'))
  })

  test('is null when the host has no catalogue to share', () => {
    expect(hostModelsCatalog({}, '/home/u', () => false)).toBeNull()
  })
})

describe('runtime catalogue', () => {
  const client = { providers: async () => RESPONSE, version: async () => '1.18.21' }

  test('reads fully qualified ids and the runtime version', async () => {
    const catalog = await readRuntimeCatalog(client as never)
    expect(catalog.version).toBe('1.18.21')
    expect([...catalog.models]).toEqual(flattenProviders(RESPONSE))
  })

  test('compares exact full ids and never strips a provider prefix', async () => {
    // The shard's own suggestion was the prefix-less key; that is not a match.
    expect(splitModelId('wandb/deepseek-ai/DeepSeek-V4-Pro-0813')).toEqual({
      providerID: 'wandb', modelID: 'deepseek-ai/DeepSeek-V4-Pro-0813',
    })
    const catalog = await readRuntimeCatalog(client as never)
    expect(missingModels(catalog, [
      'wandb/deepseek-ai/DeepSeek-V4-Flash',
      'wandb/deepseek-ai/DeepSeek-V4-Pro-0813',
      'deepseek-ai/DeepSeek-V4-Flash',
      'wandb/deepseek-ai/DeepSeek-V4-Pro-0813',
    ])).toEqual(['wandb/deepseek-ai/DeepSeek-V4-Pro-0813', 'deepseek-ai/DeepSeek-V4-Flash'])
  })

  test('names the model, the Docker runtime, its version and the shard', () => {
    expect(modelUnavailableMessage('wandb/deepseek-ai/DeepSeek-V4-Pro-0813', '1.18.21', 2)).toBe(
      'Model unavailable in Docker runtime (OpenCode 1.18.21, shard 2): ' +
        'wandb/deepseek-ai/DeepSeek-V4-Pro-0813 is not in its model catalogue',
    )
    expect(modelUnavailableMessage('p/m', null, 0)).toContain('OpenCode version unknown')
  })

  test('says credentials are missing when the whole provider is absent', async () => {
    const catalog = await readRuntimeCatalog(client as never)
    expect(hasProvider(catalog, 'wandb')).toBe(true)
    expect(hasProvider(catalog, 'google')).toBe(false)
    // A prefix of another provider id is not that provider.
    expect(hasProvider(catalog, 'wand')).toBe(false)
    expect(modelUnavailableMessage('google/gemini-3.8-flash', '1.18.21', 0, true)).toBe(
      'Provider unavailable in Docker runtime (OpenCode 1.18.21, shard 0): no credentials for "google" reached the container, ' +
        'so google/gemini-3.8-flash cannot run. Check the Auth file setting (leave it blank to use your OpenCode login)',
    )
  })
})
