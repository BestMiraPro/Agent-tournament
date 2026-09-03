import { describe, expect, test } from 'vitest'
import { lineDiff } from '../../web/src/lib/diff.js'
import { goalChangeFlags } from '../../web/src/lib/goals.js'

describe('lineDiff', () => {
  test('identical inputs are all same, text preserved', () => {
    expect(lineDiff('x\ny', 'x\ny')).toEqual([
      { kind: 'same', text: 'x' },
      { kind: 'same', text: 'y' },
    ])
  })

  test('pure additions: empty a, lines in b', () => {
    expect(lineDiff('', 'x\ny')).toEqual([
      { kind: 'add', text: 'x' },
      { kind: 'add', text: 'y' },
    ])
  })

  test('pure deletions: lines in a, empty b', () => {
    expect(lineDiff('x\ny', '')).toEqual([
      { kind: 'del', text: 'x' },
      { kind: 'del', text: 'y' },
    ])
  })

  test('a modified line is a del followed by an add', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
    ])
  })

  test('a reordered line is a del before the kept line and an add after it', () => {
    // Pins the deterministic tie-break: dp[i+1][j] >= dp[i][j+1] emits del first
    expect(lineDiff('x\ny\nz', 'x\nz\ny')).toEqual([
      { kind: 'same', text: 'x' },
      { kind: 'del', text: 'y' },
      { kind: 'same', text: 'z' },
      { kind: 'add', text: 'y' },
    ])
  })

  test('empty a, single line b is one add', () => {
    expect(lineDiff('', 'single')).toEqual([{ kind: 'add', text: 'single' }])
  })

  test('single line a, empty b is one del', () => {
    expect(lineDiff('single', '')).toEqual([{ kind: 'del', text: 'single' }])
  })
})

describe('goalChangeFlags', () => {
  test('no rounds, no flags', () => {
    expect(goalChangeFlags([])).toEqual([])
  })

  test('first round never flags', () => {
    expect(goalChangeFlags(['g'])).toEqual([false])
  })

  test('unchanged goals flag nowhere', () => {
    expect(goalChangeFlags(['g', 'g', 'g'])).toEqual([false, false, false])
  })

  test('flags exactly where the goal changes', () => {
    expect(goalChangeFlags(['g', 'g', 'h', 'h'])).toEqual([false, false, true, false])
  })
})
