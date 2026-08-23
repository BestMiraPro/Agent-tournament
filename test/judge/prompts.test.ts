import { describe, expect, test } from 'vitest'
import { buildCriteriaPrompt, buildScoringPrompt } from '../../src/judge/prompts.js'

describe('buildCriteriaPrompt', () => {
  test('includes the goal and demands JSON', () => {
    const p = buildCriteriaPrompt('write a haiku')
    expect(p).toContain('write a haiku')
    expect(p.toLowerCase()).toContain('json')
  })
})

describe('buildScoringPrompt', () => {
  const subs = [
    { ref: 'S1', submissionMd: 'alpha', files: [{ path: 'a.txt', bytes: 1 }] },
    { ref: 'S2', submissionMd: 'beta', files: [] },
  ]

  test('wraps each submission in a tagged block', () => {
    const p = buildScoringPrompt('goal', 'criteria', subs, 6000)
    expect(p).toContain('<submission ref="S1">')
    expect(p).toContain('<submission ref="S2">')
    expect(p).toContain('alpha')
  })

  test('truncates submissions over the cap, preserving head and tail', () => {
    const long = 'H'.repeat(50) + 'MIDDLE' + 'T'.repeat(50)
    const p = buildScoringPrompt('goal', 'criteria', [{ ref: 'S1', submissionMd: long, files: [] }], 40)
    expect(p).toContain('truncated')
    expect(p).not.toContain('MIDDLE')
    expect(p).toContain('H'.repeat(10))
    expect(p).toContain('T'.repeat(10))
  })

  test('never leaks agent labels or model ids', () => {
    const p = buildScoringPrompt('goal', 'criteria', subs, 6000)
    expect(p).not.toContain('competitor-')
    expect(p).not.toContain('wandb/')
  })

  test('lists the file manifest as supporting evidence', () => {
    const p = buildScoringPrompt('goal', 'criteria', subs, 6000)
    expect(p).toContain('a.txt')
  })
})
