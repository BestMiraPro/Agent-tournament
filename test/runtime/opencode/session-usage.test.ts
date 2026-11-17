import { describe, expect, test } from 'vitest'
import { sessionUsage } from '../../../src/runtime/opencode/agent-runner.js'

const tokens = (input: number, output: number, read: number, write: number) => ({ total: 0, input, output, reasoning: 0, cache: { read, write } })

describe('sessionUsage', () => {
  test('sums every assistant message of the session, not just the last model call', () => {
    expect(sessionUsage([
      { info: { role: 'user' } },
      { info: { role: 'assistant', cost: 0.25, tokens: tokens(100, 20, 1000, 50) } },
      { info: { role: 'assistant', cost: 0.5, tokens: tokens(30, 40, 5000, 0) } },
    ])).toEqual({ tokensIn: 130, tokensOut: 60, tokensCacheRead: 6000, tokensCacheWrite: 50, costUsd: 0.75 })
  })

  test('is null when the listing holds no assistant message, so the reply\'s own usage stands', () => {
    expect(sessionUsage([{ info: { role: 'user' } }])).toBeNull()
  })
})
