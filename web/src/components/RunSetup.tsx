import { useEffect, useState } from 'react'
import { DEFAULT_CONFIG } from '../../../src/core/types.js'
import { listModels } from '../api.js'

export interface RunSetupValue {
  name: string
  goal: string
  sandbox: 'mock' | 'local' | 'docker'
  rosterText: string
  workspaceRoot: string
  authFile: string
  criteria: string | null
  selection: { eliteCount: number; topPct: number; bottomPct: number; crossoverPct: number }
  concurrency: number
  pricingText: string
}

export function RunSetup({ busy, error, onCreate }: {
  busy: boolean
  error: string | null
  onCreate: (value: RunSetupValue) => void
}) {
  const [name, setName] = useState('arena')
  const [goal, setGoal] = useState('Produce the best possible answer.')
  const [sandbox, setSandbox] = useState<RunSetupValue['sandbox']>('mock')
  const [rosterText, setRosterText] = useState('mock/model x4 @0.7')
  const [workspaceRoot, setWorkspaceRoot] = useState('')
  const [authFile, setAuthFile] = useState('')
  const [criteria, setCriteria] = useState('')
  // Numeric inputs stay text in state (number inputs still surface strings and
  // can be emptied); App re-checks ranges on submit since the server is truth.
  const [eliteCount, setEliteCount] = useState(String(DEFAULT_CONFIG.selection.eliteCount))
  const [topPct, setTopPct] = useState(String(DEFAULT_CONFIG.selection.topPct))
  const [bottomPct, setBottomPct] = useState(String(DEFAULT_CONFIG.selection.bottomPct))
  const [crossoverPct, setCrossoverPct] = useState(String(DEFAULT_CONFIG.selection.crossoverPct))
  const [concurrency, setConcurrency] = useState(String(DEFAULT_CONFIG.concurrency))
  const [pricingText, setPricingText] = useState('')
  // Known-models is a copy-paste aid only: failure or an empty list hides the
  // block and free-text inputs keep working.
  const [models, setModels] = useState<string[] | null>(null)
  useEffect(() => {
    let alive = true
    listModels().then(
      (m) => { if (alive) setModels(m) },
      () => { if (alive) setModels(null) },
    )
    return () => { alive = false }
  }, [])

  const needsPaths = sandbox !== 'mock'

  return (
    <div className="setup">
      <label htmlFor="setup-name">Run name</label>
      <input id="setup-name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
      <label htmlFor="setup-goal">Goal</label>
      <textarea id="setup-goal" value={goal} rows={3} onChange={(e) => setGoal(e.target.value)} disabled={busy} />
      <label htmlFor="setup-sandbox">Sandbox</label>
      <select
        id="setup-sandbox"
        value={sandbox}
        onChange={(e) => setSandbox(e.target.value as RunSetupValue['sandbox'])}
        disabled={busy}
      >
        <option value="mock">mock (free, no isolation)</option>
        <option value="local">local (real agents on this host)</option>
        <option value="docker">docker (isolated containers)</option>
      </select>
      <label htmlFor="setup-roster">Roster (one `model xN @temp` per line)</label>
      <textarea id="setup-roster" value={rosterText} rows={4} onChange={(e) => setRosterText(e.target.value)} disabled={busy} />
      {models !== null && models.length > 0 && (
        <details>
          <summary>Known models ({models.length})</summary>
          <ul>
            {models.map((m) => <li key={m}><code>{m}</code></li>)}
          </ul>
        </details>
      )}
      <label htmlFor="setup-criteria">Judging criteria (optional)</label>
      <textarea id="setup-criteria" value={criteria} rows={3} placeholder="auto-generate from goal" onChange={(e) => setCriteria(e.target.value)} disabled={busy} />
      <label htmlFor="setup-elite">Elite count</label>
      <input id="setup-elite" type="number" min={0} step={1} value={eliteCount} onChange={(e) => setEliteCount(e.target.value)} disabled={busy} />
      <label htmlFor="setup-toppct">Top pct (0–1)</label>
      <input id="setup-toppct" type="number" min={0} max={1} step={0.05} value={topPct} onChange={(e) => setTopPct(e.target.value)} disabled={busy} />
      <label htmlFor="setup-bottompct">Bottom pct (0–1)</label>
      <input id="setup-bottompct" type="number" min={0} max={1} step={0.05} value={bottomPct} onChange={(e) => setBottomPct(e.target.value)} disabled={busy} />
      <label htmlFor="setup-crossoverpct">Crossover pct (0–1)</label>
      <input id="setup-crossoverpct" type="number" min={0} max={1} step={0.05} value={crossoverPct} onChange={(e) => setCrossoverPct(e.target.value)} disabled={busy} />
      <label htmlFor="setup-concurrency">Concurrency (1–64)</label>
      <input id="setup-concurrency" type="number" min={1} max={64} step={1} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} disabled={busy} />
      <label htmlFor="setup-pricing">Custom pricing (one `modelId inPerM outPerM cacheReadPerM cacheWritePerM` per line, optional)</label>
      <textarea id="setup-pricing" value={pricingText} rows={3} placeholder="mymodel 2.5 10 0.5 2" onChange={(e) => setPricingText(e.target.value)} disabled={busy} />
      {/* Read-only budget display (spec section 2): the run always uses the config
          defaults; there is no override control. */}
      <p className="muted" id="setup-budget">
        Budget: {DEFAULT_CONFIG.budget.maxRunTokens.toLocaleString()} tokens/run,{' '}
        {DEFAULT_CONFIG.budget.maxRoundTokens.toLocaleString()}/round,{' '}
        {DEFAULT_CONFIG.budget.maxAgentTokens.toLocaleString()}/agent
      </p>
      {needsPaths && (
        <>
          <label htmlFor="setup-root">Workspace root</label>
          <input id="setup-root" value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} disabled={busy} />
        </>
      )}
      {sandbox === 'docker' && (
        <>
          <label htmlFor="setup-auth">Auth file (bind-mounted read-only)</label>
          <input id="setup-auth" value={authFile} onChange={(e) => setAuthFile(e.target.value)} disabled={busy} />
        </>
      )}
      {error && <p className="error">{error}</p>}
      <button
        disabled={busy || name.trim().length === 0 || goal.trim().length === 0}
        onClick={() => onCreate({
          name, goal, sandbox, rosterText, workspaceRoot, authFile,
          criteria: criteria.trim() === '' ? null : criteria,
          selection: {
            eliteCount: Number(eliteCount),
            topPct: Number(topPct),
            bottomPct: Number(bottomPct),
            crossoverPct: Number(crossoverPct),
          },
          concurrency: Number(concurrency),
          pricingText,
        })}
      >
        {busy ? 'Creating…' : 'Create run'}
      </button>
    </div>
  )
}
