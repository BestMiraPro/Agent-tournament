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

describe('MockProvider reflect with a multiline strategy', () => {
  /**
   * Crossover merges two parents by splitting on lines, so a recombined child's strategy
   * is multi-line by construction. The reflect prompt puts that strategy between
   * `YOUR STRATEGY:` and `YOUR NOTES:`, and a `.` capture stops at the first newline — so
   * the mock silently returned only the first line and the recombination was thrown away
   * on the very next round, in every mock experiment that used crossover.
   */
  const promptFor = (strategy: string) =>
    [
      'YOUR RESULT: rank 2, score 50',
      'Judge said about you: fine',
      '',
      `YOUR STRATEGY: ${strategy}`,
      'YOUR NOTES: none',
      '',
      'WHAT WON THIS ROUND:',
      'TOP STRATEGY: be concise and verify the work',
      '',
      'WHY THEY WON: they verified',
      '',
      'Next goal (unchanged):',
      'goal',
    ].join('\n')

  const reflectWith = (strategy: string) => {
    const raw = new MockProvider(7).complete({
      purpose: 'reflect', prompt: promptFor(strategy), modelId: 'mock/model',
    })
    return raw
  }

  test('keeps every line of a multiline strategy', async () => {
    const strategy = 'first line from parent A\nsecond line from parent B\nthird line'
    const out = JSON.parse(await reflectWith(strategy)) as { strategy_md: string }

    for (const line of strategy.split('\n')) {
      expect(out.strategy_md).toContain(line)
    }
  })

  test('still returns a single-line strategy unchanged apart from its mutation', async () => {
    const out = JSON.parse(await reflectWith('be brief')) as { strategy_md: string }
    expect(out.strategy_md.startsWith('be brief')).toBe(true)
    expect(out.strategy_md).not.toContain('YOUR NOTES')
  })

  test('never absorbs the surrounding prompt into the strategy', async () => {
    const out = JSON.parse(await reflectWith('line one\nline two')) as { strategy_md: string }
    expect(out.strategy_md).not.toMatch(/WHY THEY WON|TOP STRATEGY|Next goal/)
  })
})
