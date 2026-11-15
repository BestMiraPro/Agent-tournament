import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  ClaudeStreamTranslator,
  classifyClaudeFailure,
  createJsonLineReader,
  redactClaude,
  type StreamEffect,
} from '../../../src/runtime/claude-code/stream.js'

/**
 * Recorded with Claude Code 2.1.325 on 2026-11-15. `genuine-haiku-ok` is one real call on the
 * owner's subscription; the `fake-upstream-*` streams are the real CLI talking to a local fake
 * Anthropic API with a placeholder token (tool calls, permission refusals, a mid-turn message, a
 * 401 and a subscription 429). Paths and account readings are anonymised.
 */
const FIXTURES = join(import.meta.dirname, '../../fixtures/claude-code-2.1.325')

function lines(name: string): unknown[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

function run(name: string): { t: ClaudeStreamTranslator; effects: StreamEffect[] } {
  const t = new ClaudeStreamTranslator(() => 1000)
  const effects = lines(name).flatMap((o) => t.feed(o))
  return { t, effects }
}

const activities = (effects: StreamEffect[]) =>
  effects.filter((e): e is Extract<StreamEffect, { type: 'activity' }> => e.type === 'activity')

describe('Claude Code stream translation', () => {
  test('a genuine call: session, text, rate-limit reading and result usage', () => {
    const { t, effects } = run('genuine-haiku-ok.jsonl')
    expect(effects[0]).toEqual({ type: 'session', sessionId: '557654c9-3f8a-4d53-83d1-a39f26411f32' })
    const text = activities(effects).find((a) => a.kind === 'text')
    expect(text?.item).toMatchObject({ kind: 'text', summary: 'OK', sessionId: '557654c9-3f8a-4d53-83d1-a39f26411f32' })
    expect(t.rateLimit).toMatchObject({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1 })
    expect(t.result).toMatchObject({ isError: false, subtype: 'success', text: 'OK', apiErrorStatus: null })
    expect(t.usage()).toEqual({ tokensIn: 2, tokensOut: 4, tokensCacheRead: 0, tokensCacheWrite: 2552 })
  })

  test('tool calls become the same running/settled items the OpenCode bridge emits', () => {
    const { t, effects } = run('fake-upstream-tools.jsonl')
    const tools = activities(effects).filter((a) => a.kind === 'tool').map((a) => a.item)
    const write = tools.filter((i) => i.id === 'toolu_0')
    expect(write.map((i) => i.status)).toEqual(['running', 'completed'])
    expect(write[0]!.summary).toBe('Write: /work/run/ws/SUBMISSION.md')
    const outside = tools.filter((i) => i.id === 'toolu_1')
    expect(outside.at(-1)).toMatchObject({ status: 'error' })
    expect(outside.at(-1)!.output).toContain('Permission for this tool use was denied')
    expect(tools.find((i) => i.id === 'toolu_3' && i.status === 'error')!.output).toContain('denied by your permission settings')
    expect(tools.find((i) => i.id === 'toolu_4' && i.status === 'completed')).toMatchObject({ summary: 'Bash: echo hi && pwd' })
    expect(t.result).toMatchObject({ isError: false, text: 'Done.' })
    expect(t.usage()).toEqual({ tokensIn: 960, tokensOut: 336, tokensCacheRead: 3200, tokensCacheWrite: 240 })
  })

  test('usage before the result is summed once per request, not once per content line', () => {
    const t = new ClaudeStreamTranslator()
    const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }
    t.feed({ type: 'assistant', uuid: 'a', session_id: 's', message: { id: 'm1', content: [{ type: 'text', text: 'hi' }], usage } })
    t.feed({ type: 'assistant', uuid: 'b', session_id: 's', message: { id: 'm1', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], usage } })
    t.feed({ type: 'assistant', uuid: 'c', session_id: 's', message: { id: 'm2', content: [{ type: 'text', text: 'x' }], usage } })
    expect(t.usage()).toEqual({ tokensIn: 20, tokensOut: 2, tokensCacheRead: 200, tokensCacheWrite: 10 })
  })

  test('a mid-turn message is folded into the running turn: one result', () => {
    const { effects } = run('fake-upstream-steer.jsonl')
    expect(effects.filter((e) => e.type === 'result')).toHaveLength(1)
  })

  test('an expired sign-in and an exhausted subscription are distinct failures', () => {
    const auth = run('fake-upstream-401.jsonl')
    expect(auth.t.result).toMatchObject({ isError: true, apiErrorStatus: 401 })
    expect(classifyClaudeFailure({ result: auth.t.result, rateLimit: auth.t.rateLimit })).toMatchObject({ code: 'CLAUDE_AUTH_EXPIRED', httpStatus: 401 })
    expect(activities(auth.effects).find((a) => a.kind === 'error')?.item.summary).toMatch(/sign-in is missing or expired/)

    const limit = run('fake-upstream-429.jsonl')
    expect(limit.t.rateLimit).toMatchObject({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1794800000 })
    const failure = classifyClaudeFailure({ result: limit.t.result, rateLimit: limit.t.rateLimit })
    expect(failure.code).toBe('SUBSCRIPTION_LIMIT')
    expect(failure.message).toMatch(/five-hour window\); it resets at 2026-11-16 03:33:20 UTC\. This is the subscription's limit, not the agent's failure\./)
  })

  test('classification without a result still tells sign-in, limit and model apart', () => {
    expect(classifyClaudeFailure({ text: 'Invalid API key · Please run /login' }).code).toBe('CLAUDE_AUTH_EXPIRED')
    expect(classifyClaudeFailure({ text: 'Claude usage limit reached' }).code).toBe('SUBSCRIPTION_LIMIT')
    expect(classifyClaudeFailure({ text: "There's an issue with the selected model (claude-x). It may not exist." }).code).toBe('CLAUDE_MODEL_UNAVAILABLE')
    expect(classifyClaudeFailure({ text: 'boom' })).toMatchObject({ code: 'CLAUDE_ERROR', message: 'Claude Code failed: boom' })
  })

  test('structured output is carried on the result', () => {
    const t = new ClaudeStreamTranslator()
    t.feed(JSON.parse(readFileSync(join(FIXTURES, 'fake-upstream-structured.json'), 'utf8')))
    expect(t.result?.structured).toEqual({ summary: 'fine', items: [{ label: 'ok', value: 1 }] })
  })

  test('tool output is redacted, Claude tokens included', () => {
    expect(redactClaude('token sk-ant-oat01-AbC_d-9 and Bearer abc.def')).toBe('token [redacted] and Bearer [redacted]')
    const t = new ClaudeStreamTranslator()
    t.feed({ type: 'assistant', session_id: 's', message: { id: 'm', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'echo sk-ant-oat01-zzz' } }] } })
    const [effect] = t.feed({ type: 'user', session_id: 's', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'sk-ant-oat01-zzz' }] } })
    expect(effect).toMatchObject({ type: 'activity', item: { summary: 'Bash: echo [redacted]', output: '[redacted]' } })
  })
})

describe('JSON line reader', () => {
  test('reassembles lines across chunks and skips non-JSON and oversized lines', () => {
    const seen: unknown[] = []
    const reader = createJsonLineReader((o) => seen.push(o), 20)
    reader.push('{"a":1}\n{"b"')
    reader.push(':2}\nnot json\n')
    reader.push('{"c":"' + 'x'.repeat(40))
    reader.push('"}\n{"d":4}\n')
    reader.end()
    expect(seen).toEqual([{ a: 1 }, { b: 2 }, { d: 4 }])
  })
})
