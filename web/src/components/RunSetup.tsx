import { useState } from 'react'
import { DEFAULT_CONFIG } from '../../../src/core/types.js'

export interface RunSetupValue {
  name: string
  goal: string
  sandbox: 'mock' | 'local' | 'docker'
  rosterText: string
  workspaceRoot: string
  authFile: string
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
        onClick={() => onCreate({ name, goal, sandbox, rosterText, workspaceRoot, authFile })}
      >
        {busy ? 'Creating…' : 'Create run'}
      </button>
    </div>
  )
}
