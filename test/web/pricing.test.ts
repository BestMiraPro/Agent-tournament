import { describe, expect, test } from 'vitest'
import { parsePricing } from '../../web/src/lib/pricing.js'

describe('parsePricing', () => {
  test('valid 4-number line parses to a pricing record', () => {
    expect(parsePricing('mymodel 2.5 10 0.5 2')).toEqual({
      pricing: { mymodel: { inPerM: 2.5, outPerM: 10, cacheReadPerM: 0.5, cacheWritePerM: 2 } },
      error: null,
    })
  })

  test('blank lines are skipped', () => {
    const { pricing, error } = parsePricing('\n  \nm1 1 2 0.5 1\n\n')
    expect(error).toBeNull()
    expect(pricing).toEqual({ m1: { inPerM: 1, outPerM: 2, cacheReadPerM: 0.5, cacheWritePerM: 1 } })
  })

  test('2-number line is a wrong-arity error naming the line number', () => {
    const { pricing, error } = parsePricing('m1 1 2 0.5 1\nm2 1 2')
    expect(pricing).toBeNull()
    expect(error).toMatch(/line 2/)
  })

  test('non-numeric rate is an error', () => {
    const { pricing, error } = parsePricing('m1 1 abc 0.5 1')
    expect(pricing).toBeNull()
    expect(error).toMatch(/line 1/)
  })

  test('negative rate is an error', () => {
    const { pricing, error } = parsePricing('m1 1 -2 0.5 1')
    expect(pricing).toBeNull()
    expect(error).toMatch(/line 1/)
  })

  test('empty text is empty pricing, no error', () => {
    expect(parsePricing('')).toEqual({ pricing: {}, error: null })
    expect(parsePricing('  \n\n').error).toBeNull()
  })
})
