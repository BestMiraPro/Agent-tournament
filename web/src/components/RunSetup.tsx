import { useEffect, useId, useState } from 'react'
import { DEFAULT_CONFIG } from '../../../src/core/types.js'
import { getCapacity, getSubscriptions, getWebSearchStatus, listConnectors, listModels, type ConnectorList, type SubscriptionStatus, type WebSearchStatus } from '../api.js'
import { pickerChoices, runConnectorsFrom, type PickerChoice, type PickerState } from '../lib/connectors.js'
import { setupEstimate, teamSetupEstimate, type CapacityInfo, type PlacementPlan } from '../lib/placement.js'
import type { RosterEntry } from '../lib/roster.js'
import { pickerModels } from '../lib/subscriptions.js'
import { RosterBuilder, SubscriptionBadge } from './RosterBuilder.js'
import { SubscriptionsPanel } from './SubscriptionsPanel.js'

export interface RunSetupValue {
  name: string
  goal: string
  workflow: 'collaboration' | 'tournament'
  sandbox: 'mock' | 'local' | 'docker'
  roster: RosterEntry[]
  judgeModel: string
  judgeMode: 'auto' | 'single_call' | 'batched_finals'
  reflectModel: string
  workspaceRoot: string
  authFile: string
  contextDir: string
  seedStrategiesDir: string
  criteria: string | null
  selection: { eliteCount: number; topPct: number; bottomPct: number; crossoverPct: number }
  concurrency: number
  /** Each agent attempt's hard limit in minutes; null for none. */
  agentTimeoutMinutes: number | null
  /** When a still-working agent is told to wrap up, in minutes. */
  agentSteerAfterMinutes: number
  maxContainers: number
  containerMemory: string
  containerCpus: number
  isolation: 'protected' | 'shared'
  pricingText: string
  /** Connectors the run's agents get, with the write tools it opts into; ignored for mock runs. */
  connectors: { id: string; writeTools: string[] }[]
  webAccess: boolean
}

/**
 * Which connectors this run's agents get. Write tools appear only where the connector permits them, and each is
 * off until ticked here; read-only connectors offer none.
 */
export function ConnectorPicker({ choices, state, disabled, onChange }: {
  choices: PickerChoice[]
  state: PickerState
  disabled: boolean
  onChange: (next: PickerState) => void
}) {
  if (choices.length === 0) return <p className="help">No connectors yet. Add them on the Connectors page.</p>
  return (
    <div className="connector-picker">
      {choices.map((c) => {
        const entry = state[c.id] ?? { enabled: false, writeTools: [] }
        return (
          <div key={c.id}>
            <label>
              <input
                type="checkbox"
                checked={entry.enabled}
                disabled={disabled}
                onChange={() => onChange({ ...state, [c.id]: { ...entry, enabled: !entry.enabled } })}
              />{' '}
              {c.title} <code>{c.id}</code>{c.locked ? ' — read-only' : ''}{c.connected ? '' : ' — not connected yet'}
            </label>
            {entry.enabled && c.permittedWriteTools.map((tool) => (
              <label key={tool} className="connector-picker__write">
                <input
                  type="checkbox"
                  checked={entry.writeTools.includes(tool)}
                  disabled={disabled}
                  onChange={() => onChange({
                    ...state,
                    [c.id]: { ...entry, writeTools: entry.writeTools.includes(tool) ? entry.writeTools.filter((t) => t !== tool) : [...entry.writeTools, tool] },
                  })}
                />{' '}
                allow write tool <code>{tool}</code> in this run
              </label>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** Which search provider the web tools would use: the primary with its key, or the Exa fallback. */
/** Shown when the local sandbox is picked: what running agents as the operator means. */
export function LocalRunCaution() {
  return (
    <p className="caution" role="note">
      Local agents run as you on this computer. Their commands can read and change anything your account can,
      your home folder included, and what they read goes to their model provider. Use docker for work you
      would not hand to a stranger.
    </p>
  )
}

export function WebSearchStatusLine({ status }: { status: WebSearchStatus | null }) {
  if (!status) return <p className="help">Search provider: could not be read from the server.</p>
  const exa = status.fallback.mode === 'keyed' ? 'Exa with your key' : 'Exa without a key'
  return status.primary.configured
    ? <p className="help">Search provider: {status.primary.name} (key configured), falling back to {exa}.</p>
    : <p className="help">Search provider: {exa} only — set LANGSEARCH_API_KEY for {status.primary.name}, the primary (see the operator guide).</p>
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

/** Before Start: a collaboration team's one container, its summed ceilings and the estimated fit. */
export function TeamContainerSummary({ capacity, ...plan }: { population: number; memory: string; cpus: number; capacity: CapacityInfo | null }) {
  const estimate = teamSetupEstimate(plan, capacity)
  return (
    <div className="placement-summary" aria-live="polite">
      <p className="help">The whole team works in one protected container: no credentials inside, an internal-only network, model calls through the relay. Its limits are one agent&apos;s per member.</p>
      <p className="help">Ceilings: {estimate.ceilings}. These are limits, not memory set aside at launch.</p>
      <p className="help">The container restarts between rounds; the team&apos;s folder (output/, CHANNEL.md, scratch) carries over.</p>
      <p className={estimate.fit.state === 'does_not_fit' ? 'error' : 'help'}>{estimate.fit.message}</p>
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
  const [workflow, setWorkflow] = useState<RunSetupValue['workflow']>(DEFAULT_CONFIG.workflow)
  const collaboration = workflow === 'collaboration'
  const [sandbox, setSandbox] = useState<RunSetupValue['sandbox']>('mock')
  const [roster, setRoster] = useState<RosterEntry[]>([{ modelId: 'mock/model', count: 4, temperature: 0.7 }])
  const [judgeModel, setJudgeModel] = useState(DEFAULT_CONFIG.judge.modelId)
  const [judgeMode, setJudgeMode] = useState<RunSetupValue['judgeMode']>('auto')
  const [reflectModel, setReflectModel] = useState(DEFAULT_CONFIG.reflect.modelId)
  const [workspaceRoot, setWorkspaceRoot] = useState('')
  const [authFile, setAuthFile] = useState('')
  const [contextDir, setContextDir] = useState('')
  const [seedStrategiesDir, setSeedStrategiesDir] = useState('')
  const [criteria, setCriteria] = useState('')
  // Numeric inputs stay text in state (number inputs still surface strings and
  // can be emptied); App re-checks ranges on submit since the server is truth.
  const [eliteCount, setEliteCount] = useState(String(DEFAULT_CONFIG.selection.eliteCount))
  const [topPct, setTopPct] = useState(String(DEFAULT_CONFIG.selection.topPct))
  const [bottomPct, setBottomPct] = useState(String(DEFAULT_CONFIG.selection.bottomPct))
  const [crossoverPct, setCrossoverPct] = useState(String(DEFAULT_CONFIG.selection.crossoverPct))
  const [concurrency, setConcurrency] = useState(String(DEFAULT_CONFIG.concurrency))
  const [agentTimeout, setAgentTimeout] = useState('')
  const [steerAfter, setSteerAfter] = useState(String(DEFAULT_CONFIG.agentSteerAfterMs / 60_000))
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
  const [webAccess, setWebAccess] = useState(true)
  // Read when a real sandbox is chosen; a failed read stays null and the line says so.
  const [webSearch, setWebSearch] = useState<WebSearchStatus | null>(null)
  useEffect(() => {
    if (sandbox === 'mock') return
    let alive = true
    getWebSearchStatus().then(
      (s) => { if (alive) setWebSearch(s) },
      () => { if (alive) setWebSearch(null) },
    )
    return () => { alive = false }
  }, [sandbox])
  const [pricingText, setPricingText] = useState('')
  // Read once; a failure only hides the picker's choices.
  const [connectorList, setConnectorList] = useState<ConnectorList | null>(null)
  const [connectorState, setConnectorState] = useState<PickerState>({})
  useEffect(() => {
    let alive = true
    listConnectors().then(
      (l) => { if (alive) setConnectorList(l) },
      () => { if (alive) setConnectorList(null) },
    )
    return () => { alive = false }
  }, [])
  const connectorChoices = pickerChoices(connectorList)
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
  // Subscription sign-in state; a failed read leaves it null and the pickers unlabelled.
  const [subscriptions, setSubscriptions] = useState<SubscriptionStatus | null>(null)
  useEffect(() => {
    let alive = true
    getSubscriptions().then(
      (s) => { if (alive) setSubscriptions(s) },
      () => { if (alive) setSubscriptions(null) },
    )
    return () => { alive = false }
  }, [])
  const picker = pickerModels(models ?? [], subscriptions)
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
        <label htmlFor="setup-workflow">Workflow</label>
        <select
          id="setup-workflow"
          value={workflow}
          onChange={(e) => setWorkflow(e.target.value as RunSetupValue['workflow'])}
          disabled={busy}
        >
          <option value="collaboration">collaboration (one team, one shared output folder)</option>
          <option value="tournament">tournament (agents compete, the best are bred)</option>
        </select>
        <p className="help">
          {collaboration
            ? 'The agents work as one team in one shared folder, talk through CHANNEL.md, and build output/ together; that folder is judged as one piece of work. Nobody is cloned or removed, and the folder carries over between rounds.'
            : 'Each agent works alone and is judged on its own SUBMISSION.md; the best are cloned and bred, the worst removed.'}
        </p>
        <label htmlFor="setup-goal">Goal</label>
        <textarea id="setup-goal" value={goal} rows={3} onChange={(e) => setGoal(e.target.value)} disabled={busy} />
        <p className="help">What the agents are trying to do — scored every round.</p>
        <label htmlFor="setup-criteria">Judging criteria (optional)</label>
        <textarea id="setup-criteria" value={criteria} rows={3} placeholder="auto-generate from goal" onChange={(e) => setCriteria(e.target.value)} disabled={busy} />
        <p className="help">How success is judged — leave blank and the judge writes its own.</p>
        <label htmlFor="setup-context">Context folder (read-only, optional)</label>
        <input id="setup-context" value={contextDir} placeholder="C:\path\to\reference-material" onChange={(e) => setContextDir(e.target.value)} disabled={busy} />
        <p className="help">A folder of reference material that agents and the judge can read. Docker mounts it read-only; local agents can still run commands against it, so use Docker if it must stay untouched. The judge can browse the web, so do not put secrets here. Mock runs ignore it.</p>
        <label htmlFor="setup-seed-strategies">Seed strategies folder (optional)</label>
        <input id="setup-seed-strategies" value={seedStrategiesDir} placeholder="C:\path\to\strategies" onChange={(e) => setSeedStrategiesDir(e.target.value)} disabled={busy} />
        <p className="help">A folder of .md files, one starting strategy per file, handed to the agents in name order and repeated if there are more agents than files. Leave blank and agents start from placeholder keywords that only mean something in a mock run.</p>
      </section>
      <section aria-labelledby="setup-h-population">
        <h2 id="setup-h-population">Population</h2>
        <fieldset>
          <legend>Roster</legend>
          <p className="help">{collaboration ? 'Which models are on the team, and how many agents each gets. Four is what one container fits on the reference machine.' : 'Which models compete, and how many agents each gets.'}</p>
          <RosterBuilder value={roster} onChange={setRoster} models={picker.models} labels={picker.labels} disabled={busy} />
        </fieldset>
      </section>
      <section aria-labelledby="setup-h-models">
        <h2 id="setup-h-models">Models</h2>
        <label htmlFor="setup-judge-model">Judge model</label>
        <input id="setup-judge-model" type="text" list={modelListId} value={judgeModel} onChange={(e) => setJudgeModel(e.target.value)} disabled={busy} />
        {picker.labels[judgeModel] && <SubscriptionBadge />}
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
        {picker.labels[reflectModel] && <SubscriptionBadge />}
        <p className="help">{collaboration ? "Reflection rewrites each agent's strategy from the team's score and its own part in the work." : "Reflection rewrites each survivor's strategy — the mutation operator."}</p>
        <datalist id={modelListId}>
          {picker.models.map((m) => <option key={m} value={m} label={picker.labels[m] ? `${m} (subscription)` : undefined} />)}
        </datalist>
      </section>
      <section aria-labelledby="setup-h-subscriptions">
        <h2 id="setup-h-subscriptions">Subscriptions</h2>
        <p className="help">Run agents, the judge and the reflector on your Claude Pro/Max or ChatGPT Plus/Pro subscription instead of API keys. Subscription calls count tokens against the budget and cost $0; the subscription's own usage limits still apply.</p>
        <SubscriptionsPanel status={subscriptions} onChange={setSubscriptions} disabled={busy} />
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
        {sandbox === 'local' && <LocalRunCaution />}
        {needsPaths && (
          <>
            <label htmlFor="setup-root">Workspace root</label>
            <input id="setup-root" value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} disabled={busy} />
            <p className="help">Absolute folder where agents work. Leave blank to use the app&apos;s default.</p>
            <label htmlFor="setup-web" className="check">
              <input id="setup-web" type="checkbox" checked={webAccess} onChange={(e) => setWebAccess(e.target.checked)} disabled={busy} />
              Web access
            </label>
            <p className="help">Agents can search the web and read pages through the host&apos;s web tools. Every call is recorded as evidence and limited per agent; search keys never reach the agents. Local and docker agents reach them through the tool bridge; docker workers still have no open network.</p>
            <WebSearchStatusLine status={webSearch} />
          </>
        )}
        {sandbox === 'docker' && (
          <>
            <label htmlFor="setup-auth">Credentials file (auth.json)</label>
            <input id="setup-auth" value={authFile} onChange={(e) => setAuthFile(e.target.value)} disabled={busy} />
            <p className="help">Your provider credentials file, mounted read-only into containers. Not for context — use Context folder above for that. Leave blank to use your OpenCode login.</p>
            {!collaboration && (
              <>
                <label htmlFor="setup-containers">Containers</label>
                <input id="setup-containers" type="number" min={1} max={64} step={1} value={maxContainers} onChange={(e) => setMaxContainers(e.target.value)} disabled={busy} />
                <p className="help">How many containers the agents are spread across. With fewer containers than agents, agents share one and can reach each other&apos;s files, so their results cannot be certified untouched. Match the agent count for full isolation.</p>
              </>
            )}
            <label htmlFor="setup-container-memory">{collaboration ? 'Memory per agent' : 'Memory per container'}</label>
            <input id="setup-container-memory" value={containerMemory} onChange={(e) => setContainerMemory(e.target.value)} disabled={busy} />
            <p className="help">{collaboration
              ? 'For example 768m or 1g; the team container gets this much per agent. 512m is accepted but ran out of memory in measured research work.'
              : 'For example 768m or 1g; 512m is accepted but ran out of memory in measured research work. Containers times memory has to fit in the memory Docker has free.'}</p>
            <label htmlFor="setup-container-cpus">{collaboration ? 'CPUs per agent' : 'CPUs per container'}</label>
            <input id="setup-container-cpus" type="number" min={0.25} max={64} step={0.25} value={containerCpus} onChange={(e) => setContainerCpus(e.target.value)} disabled={busy} />
            <p className="help">{collaboration ? 'Agents times CPUs cannot exceed this machine\'s CPU count.' : 'Containers times CPUs cannot exceed this machine\'s CPU count.'}</p>
            {collaboration && (
              <TeamContainerSummary
                population={roster.reduce((n, r) => n + r.count, 0)}
                memory={containerMemory.trim()}
                cpus={Number(containerCpus)}
                capacity={capacity}
              />
            )}
            {!collaboration && (<>
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
            </>)}
          </>
        )}
      </section>
      <section aria-labelledby="setup-h-connectors">
        <h2 id="setup-h-connectors">Connectors</h2>
        {sandbox === 'mock'
          ? <p className="help">Mock agents do not call tools; connectors apply to local and docker runs.</p>
          : <ConnectorPicker choices={connectorChoices} state={connectorState} disabled={busy} onChange={setConnectorState} />}
        <p className="help">Agents reach connectors through the dashboard&apos;s tool bridge, which holds the credentials and records every call. Slack and Gmail are read-only and locked.</p>
      </section>
      <details>
        <summary>Advanced</summary>
        {collaboration && <p className="help">Collaboration never selects or breeds, so elites, bands and crossover do not apply, and every agent runs at once.</p>}
        {!collaboration && (<>
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
        </>)}
        <label htmlFor="setup-agent-timeout">Agent time limit (minutes)</label>
        <input id="setup-agent-timeout" type="number" min={1} step={1} placeholder="none" value={agentTimeout} onChange={(e) => setAgentTimeout(e.target.value)} disabled={busy} />
        <p className="help">Each agent is stopped after this long and keeps what it wrote. Blank for no limit.</p>
        <label htmlFor="setup-steer-after">Ask agents to wrap up after (minutes)</label>
        <input id="setup-steer-after" type="number" min={1} step={1} value={steerAfter} onChange={(e) => setSteerAfter(e.target.value)} disabled={busy} />
        <p className="help">A still-working agent is told to finish what it has; it is not cut off.</p>
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
          name, goal, workflow, sandbox, roster, judgeModel, judgeMode, reflectModel,
          workspaceRoot, authFile, contextDir, seedStrategiesDir,
          criteria: criteria.trim() === '' ? null : criteria,
          selection: {
            eliteCount: Number(eliteCount),
            topPct: Number(topPct),
            bottomPct: Number(bottomPct),
            crossoverPct: Number(crossoverPct),
          },
          concurrency: Number(concurrency),
          agentTimeoutMinutes: agentTimeout.trim() === '' ? null : Number(agentTimeout),
          agentSteerAfterMinutes: Number(steerAfter),
          maxContainers: Number(maxContainers),
          containerMemory: containerMemory.trim(),
          containerCpus: Number(containerCpus),
          isolation,
          pricingText,
          connectors: sandbox === 'mock' ? [] : runConnectorsFrom(connectorState, connectorChoices),
          webAccess,
        })}
      >
        {busy ? 'Creating…' : 'Create run'}
      </button>
    </div>
  )
}
