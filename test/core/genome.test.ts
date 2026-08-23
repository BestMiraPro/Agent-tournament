import { describe, expect, test } from 'vitest'
import { serializeGenome, parseGenome, capStrategy } from '../../src/core/genome.js'
import type { Genome } from '../../src/core/types.js'

const g: Genome = {
  strategyMd: 'Read the goal twice. Verify before submitting.',
  notesMd: 'Round 1: concise answers scored well.',
  modelId: 'wandb/deepseek-ai/DeepSeek-V4-Flash',
  temperature: 0.7,
}

describe('genome serialization', () => {
  test('serialize emits YAML frontmatter with the strategy as the body', () => {
    const md = serializeGenome(g, { label: 'competitor-07' })
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain('description: competitor-07')
    expect(md).toContain('model: wandb/deepseek-ai/DeepSeek-V4-Flash')
    expect(md).toContain('temperature: 0.7')
    expect(md).toContain('webfetch: deny')
    expect(md).toContain('Read the goal twice.')
  })

  test('round-trips strategy, model and temperature', () => {
    const parsed = parseGenome(serializeGenome(g, { label: 'competitor-07' }))
    expect(parsed.strategyMd).toBe(g.strategyMd)
    expect(parsed.modelId).toBe(g.modelId)
    expect(parsed.temperature).toBe(g.temperature)
  })

  test('preserves multi-segment wandb model ids', () => {
    const parsed = parseGenome(serializeGenome(g, { label: 'x' }))
    expect(parsed.modelId.split('/').length).toBe(3)
  })

  test('parse throws on missing frontmatter', () => {
    expect(() => parseGenome('no frontmatter here')).toThrow(/frontmatter/i)
  })

  test('capStrategy truncates at the cap', () => {
    expect(capStrategy('abcdefghij', 5)).toHaveLength(5)
    expect(capStrategy('abc', 10)).toBe('abc')
  })

  test('capStrategy cuts on a word boundary when one is near the cap', () => {
    expect(capStrategy('hello world foo', 12)).toBe('hello world')
  })

  test('parse throws on non-numeric temperature', () => {
    const md = [
      '---',
      'description: bad',
      'model: wandb/deepseek-ai/DeepSeek-V4-Flash',
      'temperature: not-a-number',
      'permission:',
      '  edit: allow',
      '  bash: allow',
      '  webfetch: deny',
      '---',
      'body',
      '',
    ].join('\n')
    expect(() => parseGenome(md)).toThrow(/temperature/i)
  })
})
