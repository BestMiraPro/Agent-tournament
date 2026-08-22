import { describe, expect, test } from 'vitest'
import { makeRng } from '../../src/core/rng.js'

describe('makeRng', () => {
  test('same seed produces same sequence', () => {
    const a = makeRng(42)
    const b = makeRng(42)
    const seqA = [a.next(), a.next(), a.next()]
    const seqB = [b.next(), b.next(), b.next()]
    expect(seqA).toEqual(seqB)
  })

  test('different seeds produce different sequences', () => {
    const a = makeRng(1)
    const b = makeRng(2)
    expect(a.next()).not.toEqual(b.next())
  })

  test('next returns values in [0, 1)', () => {
    const r = makeRng(7)
    for (let i = 0; i < 200; i++) {
      const v = r.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  test('pick returns a member of the array', () => {
    const r = makeRng(3)
    const items = ['a', 'b', 'c']
    for (let i = 0; i < 20; i++) expect(items).toContain(r.pick(items))
  })

  test('shuffle is a permutation and is deterministic', () => {
    const items = [1, 2, 3, 4, 5, 6]
    const s1 = makeRng(9).shuffle(items)
    const s2 = makeRng(9).shuffle(items)
    expect(s1).toEqual(s2)
    expect([...s1].sort((x, y) => x - y)).toEqual(items)
  })
})
