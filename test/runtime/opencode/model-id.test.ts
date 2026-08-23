import { describe, expect, test } from 'vitest'
import { splitModelId, joinModelId } from '../../../src/runtime/opencode/model-id.js'

describe('splitModelId', () => {
  test('splits a two-segment id', () => {
    expect(splitModelId('opencode/big-pickle')).toEqual({
      providerID: 'opencode',
      modelID: 'big-pickle',
    })
  })

  test('splits a three-segment id on the FIRST slash only', () => {
    expect(splitModelId('wandb/deepseek-ai/DeepSeek-V4-Flash')).toEqual({
      providerID: 'wandb',
      modelID: 'deepseek-ai/DeepSeek-V4-Flash',
    })
  })

  test('handles a four-segment id', () => {
    expect(splitModelId('a/b/c/d')).toEqual({ providerID: 'a', modelID: 'b/c/d' })
  })

  test('throws when there is no slash', () => {
    expect(() => splitModelId('nomodel')).toThrow(/provider/i)
  })

  test('throws on an empty provider', () => {
    expect(() => splitModelId('/model')).toThrow(/provider/i)
  })

  test('throws on an empty model', () => {
    expect(() => splitModelId('provider/')).toThrow(/model/i)
  })

  test('joinModelId is the inverse of splitModelId', () => {
    const id = 'wandb/deepseek-ai/DeepSeek-V4-Flash'
    expect(joinModelId(splitModelId(id))).toBe(id)
  })
})
