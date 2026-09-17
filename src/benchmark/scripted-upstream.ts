/**
 * The Task C deterministic workload: a scripted OpenAI-compatible upstream that drives
 * real protected workers through sustained model/tool exchanges.
 *
 * The script is stateless per HTTP call: it counts completed tool executions in the
 * request's own message history and emits more tool calls until the turn budget is
 * spent, then a final text. An unreadable body ends the session rather than looping.
 * Every command runs inside the agent's workspace (the session directory), is
 * deterministic (seeded), and finishes in seconds; step zero runs the existing
 * pandas/DuckDB/matplotlib research pytest, later steps synthesize substantial
 * output so the conversation — the thing whose memory is measured — keeps growing.
 */

/** Catalogue-listed, tool-capable roster model, overridden to the relay like production. */
export const BENCH_MODEL = 'wandb/deepseek-ai/DeepSeek-V4-Flash'
export const BENCH_PROVIDER = 'wandb'

/** Completed tool executions in a chat-completions request body; null when unreadable. */
export function countToolTurns(body: Buffer | string): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { messages?: unknown }).messages)) {
    return null
  }
  let turns = 0
  for (const m of (parsed as { messages: unknown[] }).messages) {
    if (typeof m === 'object' && m !== null && (m as { role?: unknown }).role === 'tool') turns++
  }
  return turns
}

/** Tool executions in a `GET /session/:id/message` listing; anything unreadable is 0. */
export function countSessionToolTurns(messages: unknown): number {
  if (!Array.isArray(messages)) return 0
  let turns = 0
  for (const m of messages) {
    const parts = (m as { parts?: unknown }).parts
    if (!Array.isArray(parts)) continue
    for (const p of parts) {
      if (typeof p !== 'object' || p === null) continue
      const part = p as { type?: unknown; tool?: unknown }
      if (part.type === 'tool' && part.tool !== 'StructuredOutput') turns++
    }
  }
  return turns
}

/**
 * One step of the workload: `callsPerStep` parallel bash calls. Step zero runs the
 * research pytest; other steps synthesize deterministic output. The final batch also
 * writes the round's submission, so capture has something to find before teardown.
 */
export function workloadCommands(step: number, agentId: string): string[] {
  if (step === 0) {
    return [
      `python -m pytest -q -p no:cacheprovider test_backtest.py 2>&1 | tail -3`,
      `python3 -c "import numpy as np; rng=np.random.default_rng(${7 + step}); x=rng.normal(0,1,4000); print(' '.join(f'{v:.4f}' for v in x))" | wc -c`,
      `python3 -c "print('\n'.join(f'asset-{i:03d} pnl={((i*37)%101)-50:+d} vol={((i*13)%40)/100:.2f}' for i in range(600)))" | tail -8`,
      `ls -la && du -sh .`,
    ]
  }
  const seed = 1000 + step * 17
  return [
    `python3 -c "import numpy as np; rng=np.random.default_rng(${seed}); x=rng.normal(0,1,6000); print(' '.join(f'{v:.5f}' for v in x))" | wc -c`,
    `python3 -c "print('\n'.join(f'step-${step} row-{i:04d} ' + 'x'*(40+(i%60)) for i in range(900)))" | wc -c`,
    `python3 -c "import hashlib; print('\n'.join(hashlib.sha256(f'${agentId}-${step}-{i}'.encode()).hexdigest() for i in range(700)))" | tail -4`,
    `echo "step ${step} checkpoint" >> PROGRESS.log && wc -l PROGRESS.log && ls`,
  ]
}

export interface ScriptStep {
  agentId: string
  /** Null (unreadable history) ends the session safely. */
  toolTurns: number | null
  turnBudget: number
  callsPerStep: number
}

/** The SSE payload for the next model step: more tools, or the final text. */
export function scriptedSse(step: ScriptStep): string {
  const done = (text: string) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
  if (step.toolTurns === null) return done(`Finished without a readable history; see SUBMISSION.md.`)
  if (step.toolTurns >= step.turnBudget) {
    return done(`Research complete after ${step.toolTurns} tool exchanges. The round submission is in SUBMISSION.md.`)
  }
  const remaining = step.turnBudget - step.toolTurns
  const calls = workloadCommands(Math.floor(step.toolTurns / step.callsPerStep), step.agentId)
  const lastBatch = remaining <= step.callsPerStep
  const toolCalls = calls.map((command, i) => ({
    index: i,
    id: `call_${step.toolTurns}_${i}`,
    type: 'function',
    function: {
      name: 'bash',
      arguments: JSON.stringify({
        command: lastBatch && i === 0
          ? `${command}; printf '%s\\n' '# Round submission' '' 'Completed ${step.turnBudget} tool exchanges of sustained research (pandas/DuckDB/matplotlib).' > SUBMISSION.md && echo SUBMISSION_WRITTEN`
          : command,
      }),
    },
  }))
  return (
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '', tool_calls: toolCalls }, finish_reason: 'tool_calls' }] })}\n\n` +
    `data: [DONE]\n\n`
  )
}
