import { describe, expect, test } from 'vitest'
import { flattenProviders } from '../../../src/runtime/opencode/discovery.js'

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
