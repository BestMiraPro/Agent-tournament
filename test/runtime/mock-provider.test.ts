import { describe, expect, test } from 'vitest'
import { MockProvider, GOOD_KEYWORDS, trueFitness } from '../../src/runtime/mock-provider.js'

describe('trueFitness', () => {
  test('rewards strategies containing good keywords', () => {
    expect(trueFitness('verify and test')).toBeGreaterThan(trueFitness('do stuff'))
  })

  test('is monotonic in keyword count', () => {
    const one = trueFitness(GOOD_KEYWORDS[0]!)
    const two = trueFitness(`${GOOD_KEYWORDS[0]} ${GOOD_KEYWORDS[1]}`)
    expect(two).toBeGreaterThan(one)
  })
})

describe('MockProvider', () => {
  test('returns parseable JSON for a criteria call', async () => {
    const p = new MockProvider(1)
    const out = await p.complete({ purpose: 'criteria', prompt: 'goal: write a poem', modelId: 'm' })
    expect(() => JSON.parse(out)).not.toThrow()
  })

  test('ranks judge submissions by embedded fitness', async () => {
    const p = new MockProvider(1)
    const prompt = [
      '<submission ref="S1">FITNESS=2</submission>',
      '<submission ref="S2">FITNESS=9</submission>',
    ].join('\n')
    const out = await p.complete({ purpose: 'judge', prompt, modelId: 'm' })
    const parsed = JSON.parse(out)
    expect(parsed.rankings[0].ref).toBe('S2')
    expect(parsed.rankings).toHaveLength(2)
  })

  test('reflection output is valid JSON with a strategy', async () => {
    const p = new MockProvider(1)
    const out = await p.complete({
      purpose: 'reflect',
      prompt: 'YOUR STRATEGY: be brief\nTOP STRATEGY: verify everything',
      modelId: 'm',
    })
    const parsed = JSON.parse(out)
    expect(typeof parsed.strategy_md).toBe('string')
    expect(parsed.strategy_md.length).toBeGreaterThan(0)
  })

  test('reflection imitates keywords from top strategies', async () => {
    const p = new MockProvider(1)
    const out = await p.complete({
      purpose: 'reflect',
      prompt: `YOUR STRATEGY: plain\nTOP STRATEGY: ${GOOD_KEYWORDS.join(' ')}`,
      modelId: 'm',
    })
    const parsed = JSON.parse(out)
    expect(trueFitness(parsed.strategy_md)).toBeGreaterThan(trueFitness('plain'))
  })

  test('is deterministic for a given seed', async () => {
    const a = await new MockProvider(7).complete({ purpose: 'reflect', prompt: 'YOUR STRATEGY: x', modelId: 'm' })
    const b = await new MockProvider(7).complete({ purpose: 'reflect', prompt: 'YOUR STRATEGY: x', modelId: 'm' })
    expect(a).toBe(b)
  })
})
