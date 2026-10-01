import { describe, expect, test } from 'vitest'
import {
  BENCH_MODEL,
  countSessionToolTurns,
  countToolTurns,
  scriptedSse,
  workloadCommands,
} from '../../src/benchmark/scripted-upstream.js'

const chatBody = (toolResults: number) =>
  Buffer.from(JSON.stringify({
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    messages: [
      { role: 'system', content: 'strategy' },
      { role: 'user', content: 'goal' },
      ...Array.from({ length: toolResults }, (_, i) => (i % 2 === 0
        ? { role: 'assistant', content: '', tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: 'bash', arguments: '{}' } }] }
        : { role: 'tool', tool_call_id: `call_${i - 1}`, content: 'output' })),
    ],
  }), 'utf8')

describe('countToolTurns', () => {
  test('counts tool-result messages in a chat-completions request', () => {
    expect(countToolTurns(chatBody(0))).toBe(0)
    expect(countToolTurns(chatBody(6))).toBe(3)
  })

  test('unparseable bodies end the session safely instead of looping forever', () => {
    expect(countToolTurns(Buffer.from('not json', 'utf8'))).toBeNull()
    expect(countToolTurns(Buffer.from('{"messages":"nope"}', 'utf8'))).toBeNull()
    expect(countToolTurns(Buffer.from('{"messages":[{"role":"user"}]}', 'utf8'))).toBe(0)
  })
})

describe('scriptedSse', () => {
  test('below budget it returns bash tool calls, at budget a final text', () => {
    const tools = scriptedSse({ agentId: 'a0', toolTurns: 0, turnBudget: 100, callsPerStep: 4 })
    expect(tools).toContain('"name":"bash"')
    expect(tools).toMatch(/call_0_\d/)
    expect(tools).toContain('data: [DONE]')
    const done = scriptedSse({ agentId: 'a0', toolTurns: 100, turnBudget: 100, callsPerStep: 4 })
    expect(done).not.toContain('tool_calls')
    expect(done).toContain('SUBMISSION.md')
  })

  test('an unreadable turn count also ends the session', () => {
    expect(scriptedSse({ agentId: 'a0', toolTurns: null, turnBudget: 100, callsPerStep: 4 })).not.toContain('tool_calls')
  })

  test('the last tool batch writes the submission', () => {
    const last = scriptedSse({ agentId: 'a0', toolTurns: 96, turnBudget: 100, callsPerStep: 4 })
    expect(last).toContain('SUBMISSION.md')
  })
})

describe('workloadCommands', () => {
  test('every command stays inside the workspace and is time-bounded', () => {
    for (const step of [0, 1, 7, 25]) {
      const cmds = workloadCommands(step, 'a0')
      expect(cmds).toHaveLength(4)
      for (const c of cmds) {
        expect(c).not.toMatch(/\/tmp|\/home|rm -rf|mkfs|curl|wget|pip install/)
        expect(c.length).toBeLessThan(2000)
      }
    }
  })

  test('step zero runs the research pytest, later steps synthesize output', () => {
    expect(workloadCommands(0, 'a0').join('\n')).toContain('pytest')
  })
})

describe('countSessionToolTurns', () => {
  test('counts tool parts across session messages, skipping structured output', () => {
    const messages = [
      { parts: [{ type: 'text', text: 'hi' }] },
      { parts: [{ type: 'tool', tool: 'bash', state: { status: 'completed' } }, { type: 'tool', tool: 'StructuredOutput' }] },
      { parts: [{ type: 'tool', tool: 'read', state: {} }] },
    ]
    expect(countSessionToolTurns(messages)).toBe(2)
    expect(countSessionToolTurns(null)).toBe(0)
  })

  test('the benchmark model is a catalogue-listed tool-capable roster model', () => {
    expect(BENCH_MODEL).toBe('wandb/deepseek-ai/DeepSeek-V4-Flash')
  })
})
