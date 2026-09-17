import { useEffect, useId, useState } from 'react'
import { DEFAULT_CONFIG } from '../../../src/core/types.js'
import { getCapacity, listModels } from '../api.js'
import { setupEstimate, type CapacityInfo, type PlacementPlan } from '../lib/placement.js'
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
  contextDir: string
  criteria: string | null
  selection: { eliteCount: number; topPct: number; bottomPct: number; crossoverPct: number }
  concurrency: number
  maxContainers: number
  containerMemory: string
  containerCpus: number
  isolation: 'protected' | 'shared'
  pricingText: string
}

/** Before Start: which agents share which container, the summed ceilings, and the estimated fit. */
export function DockerPlacementSummary({ capacity, concurrency, ...plan }: PlacementPlan & { capacity: CapacityInfo | null; concurrency: number }) {
  const estimate = setupEstimate(plan, capacity)
  const agents = Math.max(0, Math.floor(plan.population))
  const atOnce = Math.max(1, Math.floor(concurrency))
  return (
    <div className="placement-summary" aria-live="polite">
      <p className="help">Agents: {agents} in the roster, up to {atOnce} running at once (Max parallel agents — your setting, shown as-is and never reduced silently).</p>
      <p className="help">Placement: {estimate.placement || 'no agents yet'}. {estimate.sharing}</p>
      <p className="help">Ceilings: {estimate.ceilings}. These are limits, not memory set aside at launch.</p>
      <p className="help">Worker runtimes restart between rounds: each round provisions fresh containers and retires the old ones after their evidence is captured, so per-round memory cannot accumulate across rounds. An agent&apos;s strategy and notes carry over; its OpenCode session history does not.</p>
      <p className={estimate.fit.state === 'does_not_fit' ? 'error' : 'help'}>{estimate.fit.message}</p>
      {estimate.refusal && <p className="error">{estimate.refusal}</p>}
      {estimate.memoryNote && <p className="help">{estimate.memoryNote}</p>}
    </div>
  )
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
  const [contextDir, setContextDir] = useState('')
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
  const [isolation, setIsolation] = useState<RunSetupValue['isolation']>('protected')
  // Read when docker is chosen; a failed read stays null and the summary says capacity is unknown.
  const [capacity, setCapacity] = useState<CapacityInfo | null>(null)
  useEffect(() => {
    if (sandbox !== 'docker') return
    let alive = true
    getCapacity().then(
      (c) => { if (alive) setCapacity(c) },
      () => { if (alive) setCapacity(null) },
    )
    return () => { alive = false }
  }, [sandbox])
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
        <label htmlFor="setup-context">Context folder (read-only, optional)</label>
        <input id="setup-context" value={contextDir} placeholder="C:\path\to\reference-material" onChange={(e) => setContextDir(e.target.value)} disabled={busy} />
        <p className="help">A folder of reference material that agents and the judge can read. Docker mounts it read-only; local agents can still run commands against it, so use Docker if it must stay untouched. The judge can browse the web, so do not put secrets here. Mock runs ignore it.</p>
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
            <label htmlFor="setup-auth">Credentials file (auth.json)</label>
            <input id="setup-auth" value={authFile} onChange={(e) => setAuthFile(e.target.value)} disabled={busy} />
            <p className="help">Your provider credentials file, mounted read-only into containers. Not for context — use Context folder above for that. Leave blank to use your OpenCode login.</p>
            <label htmlFor="setup-containers">Containers</label>
            <input id="setup-containers" type="number" min={1} max={64} step={1} value={maxContainers} onChange={(e) => setMaxContainers(e.target.value)} disabled={busy} />
            <p className="help">How many containers the agents are spread across. With fewer containers than agents, agents share one and can reach each other&apos;s files, so their results cannot be certified untouched. Match the agent count for full isolation.</p>
            <label htmlFor="setup-container-memory">Memory per container</label>
            <input id="setup-container-memory" value={containerMemory} onChange={(e) => setContainerMemory(e.target.value)} disabled={busy} />
            <p className="help">For example 768m or 1g; 512m is accepted but ran out of memory in measured research work. Containers times memory has to fit in the memory Docker has free.</p>
            <label htmlFor="setup-container-cpus">CPUs per container</label>
            <input id="setup-container-cpus" type="number" min={0.25} max={64} step={0.25} value={containerCpus} onChange={(e) => setContainerCpus(e.target.value)} disabled={busy} />
            <p className="help">Containers times CPUs cannot exceed this machine&apos;s CPU count.</p>
            <label htmlFor="setup-isolation">Isolation</label>
            <select
              id="setup-isolation"
              value={isolation}
              onChange={(e) => setIsolation(e.target.value as RunSetupValue['isolation'])}
              disabled={busy}
            >
              <option value="protected">protected (one agent per container)</option>
              <option value="shared">shared (agents can reach each other&apos;s files)</option>
            </select>
            <p className="help">Protected refuses a run that would put two agents in one container. Shared allows it, and then no result can be certified as the agent&apos;s own untouched work.</p>
            <DockerPlacementSummary
              population={roster.reduce((n, r) => n + r.count, 0)}
              maxContainers={Number(maxContainers)}
              memory={containerMemory.trim()}
              cpus={Number(containerCpus)}
              isolation={isolation}
              concurrency={Number(concurrency)}
              capacity={capacity}
            />
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
          workspaceRoot, authFile, contextDir,
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
          isolation,
          pricingText,
        })}
      >
        {busy ? 'Creating…' : 'Create run'}
      </button>
    </div>
  )
}
