import { describe, expect, test } from 'vitest'
import { COMPETITOR_TOOLS, competitorArgs, folderRule, providerArgs } from '../../../src/runtime/claude-code/argv.js'
import {
  claudeModelOf,
  isClaudeAlias,
  isClaudeSubscriptionModel,
  requireClaudeModel,
} from '../../../src/runtime/claude-code/model-id.js'

const SESSION = '11111111-2222-4333-8444-555555555555'

describe('claude-subscription model ids', () => {
  test('accepts full ids and the CLI aliases', () => {
    expect(claudeModelOf('claude-subscription/claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(claudeModelOf('claude-subscription/opus')).toBe('opus')
    expect(claudeModelOf('claude-subscription/claude-sonnet-5-5[1m]')).toBe('claude-sonnet-5-5[1m]')
    expect(isClaudeAlias('fable')).toBe(true)
    expect(isClaudeAlias('claude-opus-5-5')).toBe(false)
  })

  test('refuses anything that could be read as a flag or is not a model id', () => {
    for (const bad of ['claude-subscription/-p', 'claude-subscription/--dangerously-skip-permissions', 'claude-subscription/', 'claude-subscription/a b', 'claude-subscription/x;rm', 'claude-subscription/../x']) {
      expect(claudeModelOf(bad)).toBeNull()
      expect(() => requireClaudeModel(bad)).toThrow(/not a valid Claude subscription model id/)
    }
  })

  test('only the claude-subscription prefix routes to Claude Code', () => {
    expect(isClaudeSubscriptionModel('claude-subscription/opus')).toBe(true)
    expect(isClaudeSubscriptionModel('anthropic/claude-opus-5-5')).toBe(false)
    expect(isClaudeSubscriptionModel('openai/gpt-5.5')).toBe(false)
  })
})

describe('competitor argv', () => {
  const base = { model: 'claude-opus-5-5', strategy: 'Plan, then build.', readableDirs: ['/context', '/run/arena'], sessionId: SESSION }

  test('is the verified unattended, workspace-confined, web-free policy', () => {
    const args = competitorArgs(base)
    expect(args.slice(0, 5)).toEqual(['-p', '--input-format=stream-json', '--output-format=stream-json', '--verbose', '--model=claude-opus-5-5'])
    expect(args).toContain('--append-system-prompt=Plan, then build.')
    expect(args).toContain(`--tools=${COMPETITOR_TOOLS.join(',')}`)
    expect(COMPETITOR_TOOLS).not.toContain('WebFetch')
    expect(COMPETITOR_TOOLS).not.toContain('WebSearch')
    expect(COMPETITOR_TOOLS).not.toContain('Agent')
    expect(args).toEqual(expect.arrayContaining([
      '--permission-mode=acceptEdits', '--permission-prompts=none', '--allowedTools=Bash',
      '--disallowedTools=Read(**/.env)', '--disallowedTools=Read(**/.env.*)',
      '--add-dir=/context', '--disallowedTools=Edit(//context/**)', '--disallowedTools=Write(//context/**)',
      '--disallowedTools=NotebookEdit(//context/**)', '--add-dir=/run/arena', '--disallowedTools=Edit(//run/arena/**)',
      '--strict-mcp-config', '--setting-sources=', '--no-session-persistence', '--disable-slash-commands', '--safe-mode',
      `--session-id=${SESSION}`,
    ]))
    expect(args.some((a) => a.startsWith('--mcp-config'))).toBe(false)
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  test('keeps a strategy that looks like a flag inside its value', () => {
    const args = competitorArgs({ ...base, strategy: '--dangerously-skip-permissions\nthen win' })
    expect(args).toContain('--append-system-prompt=--dangerously-skip-permissions\nthen win')
    expect(args.filter((a) => a === '--dangerously-skip-permissions')).toHaveLength(0)
  })

  test('omits an empty strategy and validates model and session before argv', () => {
    expect(competitorArgs({ ...base, strategy: '  ' }).some((a) => a.startsWith('--append-system-prompt'))).toBe(false)
    expect(() => competitorArgs({ ...base, model: '-p' })).toThrow(/invalid Claude model id/)
    expect(() => competitorArgs({ ...base, sessionId: '--resume' })).toThrow(/invalid session id/)
  })

  test('leaves a connectors seam that is off by default', () => {
    expect(competitorArgs({ ...base, mcpConfig: '/run/arena-config/mcp.json' })).toContain('--mcp-config=/run/arena-config/mcp.json')
  })

  test('refuses a read-only folder a permission rule cannot hold', () => {
    expect(folderRule('/a/b/')).toBe('//a/b/**')
    expect(folderRule('C:\\ref\\docs')).toBe('//C:/ref/docs/**')
    expect(() => folderRule('/a/(b)')).toThrow(/cannot be expressed/)
  })
})

describe('provider argv', () => {
  test('a reflect call has no tools; a grading call reads only the context folder', () => {
    const reflect = providerArgs({ model: 'sonnet', systemPrompt: 'You evaluate.', readableDirs: [] })
    expect(reflect).toEqual(expect.arrayContaining(['-p', '--output-format=json', '--model=sonnet', '--system-prompt=You evaluate.', '--tools=', '--safe-mode']))
    expect(reflect.some((a) => a.startsWith('--json-schema'))).toBe(false)
    const judge = providerArgs({ model: 'opus', systemPrompt: 's', readableDirs: ['/ctx'], schema: { type: 'object' } })
    expect(judge).toEqual(expect.arrayContaining(['--tools=Read,Glob,Grep', '--add-dir=/ctx', '--disallowedTools=Edit(//ctx/**)', '--json-schema={"type":"object"}']))
  })
})
