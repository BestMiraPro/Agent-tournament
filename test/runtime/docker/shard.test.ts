import { describe, expect, test } from 'vitest'
import { planShards, shardIndexOf } from '../../../src/runtime/docker/shard.js'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `a${i + 1}`)

describe('planShards', () => {
  test('distributes agents across the requested number of shards', () => {
    const s = planShards(ids(20), 4)
    expect(s).toHaveLength(4)
    expect(s.reduce((n, x) => n + x.agentIds.length, 0)).toBe(20)
  })

  test('balances shard sizes to within one', () => {
    const sizes = planShards(ids(20), 3).map((s) => s.agentIds.length)
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
  })

  test('assigns every agent exactly once', () => {
    const all = planShards(ids(17), 5).flatMap((s) => s.agentIds)
    expect(new Set(all).size).toBe(17)
    expect(all).toHaveLength(17)
  })

  test('never creates more shards than agents', () => {
    expect(planShards(ids(3), 10)).toHaveLength(3)
  })

  test('one shard means one container holding everyone', () => {
    const s = planShards(ids(50), 1)
    expect(s).toHaveLength(1)
    expect(s[0]!.agentIds).toHaveLength(50)
  })

  test('shards are numbered from zero contiguously', () => {
    expect(planShards(ids(9), 3).map((s) => s.shardIndex)).toEqual([0, 1, 2])
  })

  test('handles an empty population', () => {
    expect(planShards([], 4)).toEqual([])
  })

  test('throws on a non-positive shard count', () => {
    expect(() => planShards(ids(4), 0)).toThrow(/maxContainers/i)
  })

  test('is deterministic for the same input', () => {
    expect(planShards(ids(11), 3)).toEqual(planShards(ids(11), 3))
  })
})

describe('shardIndexOf', () => {
  test('finds the shard containing an agent', () => {
    const s = planShards(ids(10), 3)
    expect(shardIndexOf(s, 'a1')).toBe(0)
  })

  test('returns null for an unknown agent', () => {
    expect(shardIndexOf(planShards(ids(4), 2), 'nope')).toBeNull()
  })
})
