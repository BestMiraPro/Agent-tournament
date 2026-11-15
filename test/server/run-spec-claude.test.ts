import { describe, expect, test } from 'vitest'
import { parseRunSpec } from '../../src/server/run-spec.js'

describe('run specs with Claude subscription models', () => {
  const base = { name: 'r', goal: 'g', sandbox: 'mock' as const }

  test('accept full ids and aliases for workers, judge and reflect', () => {
    const spec = parseRunSpec({
      ...base,
      roster: [{ modelId: 'claude-subscription/claude-opus-5-5', count: 1, temperature: 0.7 }, { modelId: 'claude-subscription/sonnet', count: 1, temperature: 0.7 }],
      judge: { modelId: 'claude-subscription/opus' },
      reflect: { modelId: 'claude-subscription/haiku' },
    })
    expect(spec.judge.modelId).toBe('claude-subscription/opus')
  })

  test('refuse an id that would reach the CLI as a flag', () => {
    expect(() => parseRunSpec({ ...base, roster: [{ modelId: 'claude-subscription/--dangerously-skip-permissions', count: 1, temperature: 0.7 }] }))
      .toThrow(/not a valid Claude subscription model id/)
    expect(() => parseRunSpec({ ...base, roster: [{ modelId: 'mock/model', count: 1, temperature: 0.7 }], judge: { modelId: 'claude-subscription/-p' } }))
      .toThrow(/not a valid Claude subscription model id/)
  })
})
