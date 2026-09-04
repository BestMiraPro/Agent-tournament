import type { RunConfig } from '../api.js'

export interface DiffRow {
  field: string
  a: string
  b: string
  differs: boolean
}

function fmtRoster(roster: { modelId: string; count: number; temperature: number }[]): string {
  return roster.map((r) => `${r.modelId}(${r.count}) temp=${r.temperature}`).join('; ')
}

// Flat field-by-field config comparison. Roster is rendered as
// "modelId(count) temp=T" entries joined by "; " so a count/temp/model change
// surfaces as a single differing string. Pure, no React.
export function diffConfig(a: RunConfig, b: RunConfig): DiffRow[] {
  const rows: [string, unknown, unknown][] = [
    ['sandbox', a.sandbox, b.sandbox],
    ['judge.modelId', a.judge.modelId, b.judge.modelId],
    ['judge.mode', a.judge.mode, b.judge.mode],
    ['reflect.modelId', a.reflect.modelId, b.reflect.modelId],
    ['concurrency', a.concurrency, b.concurrency],
    ['selection.topPct', a.selection.topPct, b.selection.topPct],
    ['selection.bottomPct', a.selection.bottomPct, b.selection.bottomPct],
    ['selection.eliteCount', a.selection.eliteCount, b.selection.eliteCount],
    ['selection.crossoverPct', a.selection.crossoverPct, b.selection.crossoverPct],
    ['budget.maxRunTokens', a.budget.maxRunTokens, b.budget.maxRunTokens],
    ['budget.maxRoundTokens', a.budget.maxRoundTokens, b.budget.maxRoundTokens],
    ['budget.maxAgentTokens', a.budget.maxAgentTokens, b.budget.maxAgentTokens],
    ['roster', fmtRoster(a.roster), fmtRoster(b.roster)],
  ]
  return rows.map(([field, va, vb]) => {
    const sa = String(va)
    const sb = String(vb)
    return { field, a: sa, b: sb, differs: sa !== sb }
  })
}
