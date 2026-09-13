import { useEffect, useId, useState } from 'react'
import { DEFAULT_CONFIG } from '../../../src/core/types.js'
import { listModels } from '../api.js'
import type { RosterEntry } from '../lib/roster.js'
import { RosterBuilder } from './RosterBuilder.js'

export interface RunSetupValue {
  name: string
  goal: string
  sandbox: 'mock' | 'local' | 'docker'
  roster: RosterEntry[]
  judgeModel: string
  judgeMode: 'auto' | 'single_call' | 'batched_finals'
  reflectModel: string
  workspaceRoot: string
  authFile: string
  criteria: string | null
  selection: { eliteCount: number; topPct: number; bottomPct: number; crossoverPct: number }
  concurrency: number
  maxContainers: number
  containerMemory: string
  containerCpus: number
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
  const [roster, setRoster] = useState<RosterEntry[]>([{ modelId: 'mock/model', count: 4, temperature: 0.7 }])
  const [judgeModel, setJudgeModel] = useState(DEFAULT_CONFIG.judge.modelId)
  const [judgeMode, setJudgeMode] = useState<RunSetupValue['judgeMode']>('auto')
  const [reflectModel, setReflectModel] = useState(DEFAULT_CONFIG.reflect.modelId)
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
  const [maxContainers, setMaxContainers] = useState(String(DEFAULT_CONFIG.maxContainers))
  const [containerMemory, setContainerMemory] = useState(DEFAULT_CONFIG.containerMemory)
  const [containerCpus, setContainerCpus] = useState(String(DEFAULT_CONFIG.containerCpus))
  const [pricingText, setPricingText] = useState('')
  // Known-models is a copy-paste aid only: failure or an empty list hides the
  // datalist options and free-text inputs keep working.
  const [models, setModels] = useState<string[] | null>(null)
  useEffect(() => {
    let alive = true
    listModels().then(
      (m) => { if (alive) setModels(m) },
      () => { if (alive) setModels(null) },
    )
    return () => { alive = false }
  }, [])
  // Shared picker list for the judge/reflect comboboxes (the roster builder
  // owns its own list id internally).
  const modelListId = useId()

  const needsPaths = sandbox !== 'mock'

  return (
    <div className="setup">
      <section aria-labelledby="setup-h-run">
        <h2 id="setup-h-run">Run</h2>
        <label htmlFor="setup-name">Run name</label>
        <input id="setup-name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        <p className="help">A short name for this run.</p>
        <label htmlFor="setup-goal">Goal</label>
        <textarea id="setup-goal" value={goal} rows={3} onChange={(e) => setGoal(e.target.value)} disabled={busy} />
        <p className="help">What the agents are trying to do — scored every round.</p>
        <label htmlFor="setup-criteria">Judging criteria (optional)</label>
        <textarea id="setup-criteria" value={criteria} rows={3} placeholder="auto-generate from goal" onChange={(e) => setCriteria(e.target.value)} disabled={busy} />
        <p className="help">How success is judged — leave blank and the judge writes its own.</p>
      </section>
      <section aria-labelledby="setup-h-population">
        <h2 id="setup-h-population">Population</h2>
        <fieldset>
          <legend>Roster</legend>
          <p className="help">Which models compete, and how many agents each gets.</p>
          <RosterBuilder value={roster} onChange={setRoster} models={models ?? []} disabled={busy} />
        </fieldset>
      </section>
      <section aria-labelledby="setup-h-models">
        <h2 id="setup-h-models">Models</h2>
        <label htmlFor="setup-judge-model">Judge model</label>
        <input id="setup-judge-model" type="text" list={modelListId} value={judgeModel} onChange={(e) => setJudgeModel(e.target.value)} disabled={busy} />
        <p className="help">The judge scores every submission — a stronger model judges more consistently.</p>
        <label htmlFor="setup-judge-mode">Judge mode</label>
        <select
          id="setup-judge-mode"
          value={judgeMode}
          onChange={(e) => setJudgeMode(e.target.value as RunSetupValue['judgeMode'])}
          disabled={busy}
        >
          <option value="auto">auto</option>
          <option value="single_call">single_call</option>
          <option value="batched_finals">batched_finals</option>
        </select>
        <p className="help">How the judge reads submissions — auto picks for you.</p>
        <label htmlFor="setup-reflect-model">Reflect model</label>
        <input id="setup-reflect-model" type="text" list={modelListId} value={reflectModel} onChange={(e) => setReflectModel(e.target.value)} disabled={busy} />
        <p className="help">Reflection rewrites each survivor's strategy — the mutation operator.</p>
        <datalist id={modelListId}>
          {(models ?? []).map((m) => <option key={m} value={m} />)}
        </datalist>
      </section>
      <section aria-labelledby="setup-h-sandbox">
        <h2 id="setup-h-sandbox">Sandbox</h2>
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
        <p className="help">Where agents run — mock is free, local and docker run real agents.</p>
        {needsPaths && (
          <>
            <label htmlFor="setup-root">Workspace root</label>
            <input id="setup-root" value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} disabled={busy} />
            <p className="help">Absolute folder where agents work. Leave blank to use the app&apos;s default.</p>
          </>
        )}
        {sandbox === 'docker' && (
          <>
            <label htmlFor="setup-auth">Auth file (bind-mounted read-only)</label>
            <input id="setup-auth" value={authFile} onChange={(e) => setAuthFile(e.target.value)} disabled={busy} />
            <p className="help">Credentials the containers may read, never write. Leave blank to use your OpenCode login.</p>
            <label htmlFor="setup-containers">Containers</label>
            <input id="setup-containers" type="number" min={1} max={64} step={1} value={maxContainers} onChange={(e) => setMaxContainers(e.target.value)} disabled={busy} />
            <p className="help">How many containers the agents are spread across. With fewer containers than agents, agents share one and can reach each other&apos;s files, so their results cannot be certified untouched. Match the agent count for full isolation.</p>
            <label htmlFor="setup-container-memory">Memory per container</label>
            <input id="setup-container-memory" value={containerMemory} onChange={(e) => setContainerMemory(e.target.value)} disabled={busy} />
            <p className="help">At least 512m, for example 512m or 1g. Containers times memory has to fit in the memory Docker has free.</p>
            <label htmlFor="setup-container-cpus">CPUs per container</label>
            <input id="setup-container-cpus" type="number" min={0.25} max={64} step={0.25} value={containerCpus} onChange={(e) => setContainerCpus(e.target.value)} disabled={busy} />
            <p className="help">Containers times CPUs cannot exceed this machine&apos;s CPU count.</p>
          </>
        )}
      </section>
      <details>
        <summary>Advanced</summary>
        <label htmlFor="setup-elite">Elites (kept verbatim)</label>
        <input id="setup-elite" type="number" min={0} step={1} value={eliteCount} onChange={(e) => setEliteCount(e.target.value)} disabled={busy} />
        <p className="help">Top agents copied unchanged into the next round.</p>
        <label htmlFor="setup-toppct">Top band % (breeders)</label>
        <input id="setup-toppct" type="number" min={0} max={1} step={0.05} value={topPct} onChange={(e) => setTopPct(e.target.value)} disabled={busy} />
        <p className="help">Share of top scorers that breed the next generation (0–1).</p>
        <label htmlFor="setup-bottompct">Bottom % (culled)</label>
        <input id="setup-bottompct" type="number" min={0} max={1} step={0.05} value={bottomPct} onChange={(e) => setBottomPct(e.target.value)} disabled={busy} />
        <p className="help">Share of lowest scorers removed each round (0–1).</p>
        <label htmlFor="setup-crossoverpct">Crossover %</label>
        <input id="setup-crossoverpct" type="number" min={0} max={1} step={0.05} value={crossoverPct} onChange={(e) => setCrossoverPct(e.target.value)} disabled={busy} />
        <p className="help">Share of new agents mixed from two parents (0–1).</p>
        <label htmlFor="setup-concurrency">Max parallel agents</label>
        <input id="setup-concurrency" type="number" min={1} max={64} step={1} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} disabled={busy} />
        <p className="help">How many agents run at once (1–64).</p>
        <label htmlFor="setup-pricing">Price table (optional)</label>
        <textarea id="setup-pricing" value={pricingText} rows={3} placeholder="mymodel 2.5 10 0.5 2" onChange={(e) => setPricingText(e.target.value)} disabled={busy} />
        <p className="help">One `modelId inPerM outPerM cacheReadPerM cacheWritePerM` per line — used for the spending display.</p>
        {/* Read-only budget display (spec section 2): the run always uses the config
            defaults; there is no override control. */}
        <p className="muted" id="setup-budget">
          Budget: {DEFAULT_CONFIG.budget.maxRunTokens.toLocaleString()} tokens/run,{' '}
          {DEFAULT_CONFIG.budget.maxRoundTokens.toLocaleString()}/round,{' '}
          {DEFAULT_CONFIG.budget.maxAgentTokens.toLocaleString()}/agent
        </p>
      </details>
      {error && <p className="error">{error}</p>}
      <button
        disabled={busy || name.trim().length === 0 || goal.trim().length === 0}
        onClick={() => onCreate({
          name, goal, sandbox, roster, judgeModel, judgeMode, reflectModel,
          workspaceRoot, authFile,
          criteria: criteria.trim() === '' ? null : criteria,
          selection: {
            eliteCount: Number(eliteCount),
            topPct: Number(topPct),
            bottomPct: Number(bottomPct),
            crossoverPct: Number(crossoverPct),
          },
          concurrency: Number(concurrency),
          maxContainers: Number(maxContainers),
          containerMemory: containerMemory.trim(),
          containerCpus: Number(containerCpus),
          pricingText,
        })}
      >
        {busy ? 'Creating…' : 'Create run'}
      </button>
    </div>
  )
}
