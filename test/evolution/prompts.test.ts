import { describe, expect, test } from 'vitest'
import { buildReflectPrompt } from '../../src/evolution/prompts.js'

const input = {
  ownStrategy: 'be brief',
  ownNotes: 'round 1 notes',
  ownRank: 4,
  ownScore: 55,
  ownRationale: 'lacked evidence',
  topPerformers: [
    { rank: 1, strategy: 'verify everything', excerpt: 'careful work', rationale: 'thorough' },
    { rank: 2, strategy: 'test twice', excerpt: 'tested', rationale: 'reliable' },
  ],
  metaDigest: 'winners verified their work',
  nextGoal: 'write a haiku',
  goalChanged: true,
  strategyCharCap: 2000,
}

describe('buildReflectPrompt', () => {
  test('includes own performance and the marker the parser needs', () => {
    const p = buildReflectPrompt(input)
    expect(p).toContain('YOUR STRATEGY: be brief')
    expect(p).toContain('55')
    expect(p).toContain('lacked evidence')
  })

  test('includes each top performer with the TOP STRATEGY marker', () => {
    const p = buildReflectPrompt(input)
    expect(p.match(/TOP STRATEGY:/g)).toHaveLength(2)
    expect(p).toContain('verify everything')
  })

  test('includes the meta digest', () => {
    expect(buildReflectPrompt(input)).toContain('winners verified their work')
  })

  test('announces a changed goal', () => {
    expect(buildReflectPrompt(input)).toContain('GOAL HAS CHANGED')
  })

  test('does not announce a change when the goal is stable', () => {
    expect(buildReflectPrompt({ ...input, goalChanged: false })).not.toContain('GOAL HAS CHANGED')
  })

  test('states the character cap', () => {
    expect(buildReflectPrompt(input)).toContain('2000')
  })
})
