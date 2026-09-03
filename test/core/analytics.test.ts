import { describe, expect, test } from 'vitest'
import { strategyDiversity } from '../../src/core/analytics.js'

describe('strategyDiversity', () => {
  test('identical non-empty strategies score 0', () => {
    expect(strategyDiversity(['plan a then b', 'plan a then b', 'plan a then b'])).toBe(0)
  })

  test('fully disjoint strategies score 1', () => {
    expect(strategyDiversity(['alpha beta', 'gamma delta'])).toBe(1)
  })

  test('n = 0 scores 0 (no pairs, no diversity signal)', () => {
    expect(strategyDiversity([])).toBe(0)
  })

  test('n = 1 scores 0 (no pairs, no diversity signal)', () => {
    expect(strategyDiversity(['solo strategy'])).toBe(0)
  })

  test('a pair of two empty strings counts as identical (similarity 1, not 0/0)', () => {
    // Spec §4.1: both-empty pair counts as identical — identical strategies mean
    // 0 distance, and without the guard this pair is a 0/0 NaN.
    expect(strategyDiversity(['', ''])).toBe(0)
  })

  test('an empty strategy is disjoint from a non-empty one', () => {
    expect(strategyDiversity(['', 'a'])).toBe(1)
  })

  test('tokenization is case- and whitespace-insensitive', () => {
    expect(strategyDiversity(['Hello   World', 'hello world'])).toBe(0)
  })

  test('mixed: two identical + one disjoint averages the pair distances', () => {
    // pairs: ({a,b},{a,b}) -> 0, ({a,b},{c,d}) -> 1, ({a,b},{c,d}) -> 1; mean = 2/3
    expect(strategyDiversity(['a b', 'a b', 'c d'])).toBeCloseTo(2 / 3)
  })

  test('partial overlap with unequal set sizes divides by the union', () => {
    // |A∩B|/|A∪B| = 1/3 — an inter/|A| or inter/min(|A|,|B|) denominator
    // would give 1/1 or 1/1 and pass every other test here
    expect(strategyDiversity(['a b c', 'a'])).toBeCloseTo(2 / 3)
  })
})
