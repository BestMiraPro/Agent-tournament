import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { serializeCompetitorProfile } from '../../src/core/genome.js'
import type { Genome } from '../../src/core/types.js'

interface Rule { permission: string; pattern: string; action: 'allow' | 'deny' | 'ask' }

const contract = JSON.parse(
  readFileSync('test/fixtures/opencode-1.18.21/permission-contract.json', 'utf8'),
) as { competitorAgent: { prompt: string; temperature: number; rules: Rule[] } }

const genome: Genome = {
  strategyMd: 'SECRET STRATEGY TEXT',
  notesMd: '',
  modelId: 'wandb/deepseek-ai/DeepSeek-V4-Pro',
  temperature: 1.25,
}

/** OpenCode evaluates the last matching rule; `*` is the only wildcard these rules use. */
function evaluate(rules: Rule[], permission: string, target: string): Rule['action'] | undefined {
  const matches = (pattern: string) =>
    new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(target)
  return rules.filter((r) => r.permission === permission && matches(r.pattern)).at(-1)?.action
}

/** The rules a profile's `permission:` block declares, in order, as OpenCode appends them. */
function declaredRules(md: string): Rule[] {
  const head = md.split('\n---')[0]!.split('\n')
  const start = head.indexOf('permission:')
  const rules: Rule[] = []
  let nested: string | null = null
  for (const line of head.slice(start + 1)) {
    const top = /^ {2}([a-z_]+):\s*(allow|deny|ask)?$/.exec(line)
    const inner = /^ {4}"([^"]+)":\s*(allow|deny|ask)$/.exec(line)
    if (top && top[2]) { nested = null; rules.push({ permission: top[1]!, pattern: '*', action: top[2] as Rule['action'] }) }
    else if (top) nested = top[1]!
    else if (inner && nested) rules.push({ permission: nested, pattern: inner[1]!, action: inner[2] as Rule['action'] })
  }
  return rules
}

describe('competitor profile', () => {
  const md = serializeCompetitorProfile(genome, { label: 'competitor-01' })

  test('carries model and temperature, and no body', () => {
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain('description: competitor-01')
    expect(md).toContain('model: wandb/deepseek-ai/DeepSeek-V4-Pro')
    expect(md).toContain('temperature: 1.25')
    // A profile body becomes the agent prompt and replaces OpenCode's base system prompt;
    // the strategy keeps arriving through the prompt's `system` field instead.
    expect(md).not.toContain('SECRET STRATEGY TEXT')
    expect(md.split('\n---\n')[1] ?? '').toBe('')
    expect(contract.competitorAgent.prompt).toBe('')
  })

  test('declares exactly the rules the verified 1.18.21 runtime appended for it', () => {
    const declared = declaredRules(md)
    expect(contract.competitorAgent.rules.slice(-declared.length)).toEqual(declared)
  })

  test('effective policy: workspace work proceeds, unattended questions are denied', () => {
    const rules = contract.competitorAgent.rules
    expect(evaluate(rules, 'edit', '/work/a1/SUBMISSION.md')).toBe('allow')
    expect(evaluate(rules, 'bash', 'node backtest.mjs')).toBe('allow')
    expect(evaluate(rules, 'read', 'GOAL.md')).toBe('allow')
    expect(evaluate(rules, 'read', '.env.example')).toBe('allow')
    // The September 13 shard-2 request: answered by rule instead of waiting forever.
    expect(evaluate(rules, 'external_directory', '/tmp/*')).toBe('deny')
    expect(evaluate(rules, 'read', '.env')).toBe('deny')
    expect(evaluate(rules, 'read', 'prod.env.local')).toBe('deny')
    expect(evaluate(rules, 'doom_loop', 'bash')).toBe('deny')
    expect(evaluate(rules, 'question', '*')).toBe('deny')
    expect(evaluate(rules, 'webfetch', 'https://example.com')).toBe('deny')
    expect(rules.filter((r) => r.action === 'ask').every((r) => evaluate(rules, r.permission, r.pattern) !== 'ask')).toBe(true)
  })

  test('the driver writes this profile, not the strategy-bearing genome file', () => {
    const driver = readFileSync('src/engine/driver.ts', 'utf8')
    expect(driver).toMatch(/'\.opencode\/agents\/competitor\.md',\s*serializeCompetitorProfile\(/)
  })
})
