import { useCallback, useEffect, useRef, useState } from 'react'
import './styles.css'
import { abortRound, createAgent, createRunFull, deleteRun, getRoundStats, getRun, overrideCriteria, serverError, startRound, type FullRunSpec, type RoundStats, type RunSnapshot } from './api.js'
import { parsePricing } from './lib/pricing.js'
import { summarizeRoster } from './lib/roster.js'
import { createStartGate, isCurrentRunRequest } from './lib/lifecycle.js'
import { criteriaDraftSeed } from './lib/criteria.js'
import { useLiveRun } from './useLiveRun.js'
import { AgentDrawer } from './components/AgentDrawer.js'
import { AnalyticsPanel } from './components/AnalyticsPanel.js'
import { RoundDetail } from './components/RoundDetail.js'
import { RunSummary } from './components/RunSummary.js'
import { AgentGrid } from './components/AgentGrid.js'
import { Leaderboard } from './components/Leaderboard.js'
import { RoundControls } from './components/RoundControls.js'
import { RunSetup, type RunSetupValue } from './components/RunSetup.js'
import { RunBrowser } from './components/RunBrowser.js'
import { CompareRuns } from './components/CompareRuns.js'

export function App() {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null)
  const [view, setView] = useState<'browser' | 'setup' | 'run' | 'compare'>('browser')
  const [compareIds, setCompareIds] = useState<[string, string] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [stopped, setStopped] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  const [lastRound, setLastRound] = useState<{
    criteriaMd: string | null
    criteriaSource: 'user' | 'generated' | null
    metaDigest: string | null
  } | null>(null)
  // The same round-stats fetch feeds the summary strip + round-detail selector —
  // retained, not refetched, so no new polling beyond this existing call.
  const [roundStats, setRoundStats] = useState<RoundStats[]>([])
  const [starting, setStarting] = useState(false)
  const live = useLiveRun(snapshot)
  const gridRef = useRef<HTMLDivElement>(null)
  const navigation = useRef(0)
  const selectedRun = useRef<string | null>(null)
  const refreshGeneration = useRef(0)
  const startGate = useRef(createStartGate())

  const refresh = useCallback(async (runId: string) => {
    const request = navigation.current
    const generation = ++refreshGeneration.current
    try {
      const next = await getRun(runId)
      if (isCurrentRunRequest(selectedRun.current, runId, navigation.current, request) && refreshGeneration.current === generation) { setSnapshot(next); setError(null) }
    } catch (e) {
      if (isCurrentRunRequest(selectedRun.current, runId, navigation.current, request) && refreshGeneration.current === generation) setError(serverError(e))
    }
  }, [])

  const handleCreate = useCallback(async (value: RunSetupValue) => {
    const createNavigation = navigation.current
    let roster: FullRunSpec['roster']
    let pricing: FullRunSpec['pricing']
    try {
      roster = value.roster
      // First validation error throws (same behavior as the old line parser);
      // the builder already shows all errors inline, this guards submit.
      const summary = summarizeRoster(roster)
      if (summary.errors.length > 0) throw new Error(summary.errors[0])
      if (roster.length === 0) throw new Error('Roster is empty - add at least one line.')
      // Client checks are immediacy only; the RunSpec zod schema + cross-field
      // rule are the authority and their 400 surfaces via this same path.
      const { selection, concurrency } = value
      if (!Number.isInteger(selection.eliteCount) || selection.eliteCount < 0) {
        throw new Error(`Elite count must be an integer >= 0: ${selection.eliteCount}`)
      }
      for (const [label, pct] of [['Top pct', selection.topPct], ['Bottom pct', selection.bottomPct], ['Crossover pct', selection.crossoverPct]] as const) {
        if (!Number.isFinite(pct) || pct < 0 || pct > 1) throw new Error(`${label} must be a number in [0, 1]: ${pct}`)
      }
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
        throw new Error(`Concurrency must be an integer in [1, 64]: ${concurrency}`)
      }
      if (value.sandbox === 'docker') {
        if (!Number.isInteger(value.maxContainers) || value.maxContainers < 1 || value.maxContainers > 64) {
          throw new Error(`Containers must be an integer in [1, 64]: ${value.maxContainers}`)
        }
        if (!Number.isFinite(value.containerCpus) || value.containerCpus <= 0 || value.containerCpus > 64) {
          throw new Error(`CPUs per container must be a number in (0, 64]: ${value.containerCpus}`)
        }
        // The memory format is left to the server, which owns the one parser for it.
      }
      const parsed = parsePricing(value.pricingText)
      if (parsed.error) throw new Error(parsed.error)
      pricing = parsed.pricing ?? {}
    } catch (e) {
      setSetupError(serverError(e))
      return
    }
    // Blank model ids are omitted (undefined drops out of the JSON body) so
    // the server partials default-fill them — an explicit null would 400.
    const judgeModel = value.judgeModel.trim()
    const reflectModel = value.reflectModel.trim()
    setCreating(true)
    setSetupError(null)
    let runId: string
    try {
      ;({ runId } = await createRunFull({
        name: value.name.trim(),
        goal: value.goal.trim(),
        sandbox: value.sandbox,
        roster,
        judge: { modelId: judgeModel === '' ? undefined : judgeModel, mode: value.judgeMode },
        reflect: { modelId: reflectModel === '' ? undefined : reflectModel },
        workspaceRoot: value.workspaceRoot.trim() || null,
        authFile: value.authFile.trim() || null,
        criteria: value.criteria,
        selection: value.selection,
        concurrency: value.concurrency,
        // Only a docker run has containers to size; the others would ignore these.
        ...(value.sandbox === 'docker'
          ? { maxContainers: value.maxContainers, containerMemory: value.containerMemory, containerCpus: value.containerCpus }
          : {}),
        pricing,
      }))
    } catch (e) {
      setSetupError(serverError(e))
      setCreating(false)
      return
    }
    if (navigation.current !== createNavigation) { setCreating(false); return }
    selectedRun.current = runId
    navigation.current++
    const initialNavigation = navigation.current
    try {
      const initial = await getRun(runId)
      if (isCurrentRunRequest(selectedRun.current, runId, navigation.current, initialNavigation)) { setSnapshot(initial); setView('run') }
    } catch {
      // The run exists on the server; a failed first read should not look like a clean form.
      if (isCurrentRunRequest(selectedRun.current, runId, navigation.current, initialNavigation)) {
        setSetupError(`Run created, but loading it failed - reload the page.`)
      }
    } finally {
      setCreating(false)
    }
  }, [refresh])

  // A finished round changes the roster and the scores, so re-read the snapshot.
  useEffect(() => {
    if (!snapshot) return
    if (live.busy) return
    if (live.roundIdx === 0) return
    void refresh(snapshot.runId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.busy, live.roundIdx])

  // Last scored round's criteria/digest prefill the between-rounds controls.
  // Missing (no scored round yet, or fetch failed) = auto-generate, no digest.
  const runIdForRounds = snapshot?.runId
  const lastRoundIdx = snapshot?.lastRoundIdx
  useEffect(() => {
    if (runIdForRounds === undefined || lastRoundIdx === undefined) return
    let alive = true
    getRoundStats(runIdForRounds)
      .then((rounds) => {
        if (!alive) return
        setRoundStats(rounds)
        const last = rounds.find((r) => r.idx === lastRoundIdx) ?? null
        setLastRound(last
          ? { criteriaMd: last.criteriaMd, criteriaSource: last.criteriaSource, metaDigest: last.metaDigest }
          : { criteriaMd: null, criteriaSource: null, metaDigest: null })
      })
      .catch(() => { if (alive) { setRoundStats([]); setLastRound(null) } })
    return () => { alive = false }
  }, [runIdForRounds, lastRoundIdx])
  // A stop cannot be undone server-side, but a fresh round means this run is
  // alive again (e.g. a new run reusing this view) — drop the stale note.
  useEffect(() => {
    setStopped(false)
  }, [lastRoundIdx])

  const handleStop = useCallback((runId: string) => {
    if (!window.confirm('Stop this run? It waits for the in-flight round to finish, then stops.')) return
    setStopping(true)
    setStopError(null)
    deleteRun(runId)
      .then(() => setStopped(true))
      .catch((e) => setStopError(serverError(e)))
      .finally(() => setStopping(false))
  }, [])

  if (view === 'browser') {
    return (
      <>
        <h1>Agent Tournament — runs</h1>
        {error && <p className="error">{error}</p>}
        <RunBrowser
          onOpen={(id) => {
            const request = ++navigation.current
            selectedRun.current = id
            setError(null)
            void getRun(id).then(
              (next) => { if (request === navigation.current && selectedRun.current === id) { setSnapshot(next); setView('run') } },
              (e) => { if (request === navigation.current) setError(serverError(e)) },
            )
          }}
          onCreate={() => { navigation.current++; selectedRun.current = null; setView('setup') }}
          onCompare={(a, b) => { navigation.current++; selectedRun.current = null; setCompareIds([a, b]); setView('compare') }}
        />
      </>
    )
  }

  if (view === 'compare' && compareIds) {
    return <CompareRuns a={compareIds[0]} b={compareIds[1]} onBack={() => setView('browser')} />
  }


  if (view === 'setup') {
    return (
      <>
        <div className="arena-head">
          <h1>Agent Tournament — new run</h1>
          <button onClick={() => { navigation.current++; selectedRun.current = null; setView('browser') }}>Browse runs</button>
        </div>
        <RunSetup busy={creating} error={setupError} onCreate={handleCreate} />
      </>
    )
  }

  if (!snapshot) return <p className="error">{error ?? 'Loading run…'}</p>

  const busy = live.roundIdx >= snapshot.lastRoundIdx ? live.busy : snapshot.busy
  const activeRoundIdx = live.busy ? live.roundIdx : snapshot.lastRoundIdx

  return (
    <>
      <div className="arena-head">
        <h1>Agent Tournament — {snapshot.name}</h1>
        <button onClick={() => { navigation.current++; selectedRun.current = null; setView('browser') }}>Back to runs</button>
        {!stopped && (
          <button className="stop" disabled={stopping} onClick={() => handleStop(snapshot.runId)}>
            {stopping ? 'Stopping…' : 'Stop run'}
          </button>
        )}
      </div>
      {stopped && <p className="muted">Run stopped.</p>}
      {stopError && <p className="error">{stopError}</p>}
      {error && <p className="error">{error} <button onClick={() => { void refresh(snapshot.runId) }}>Retry</button></p>}
      {snapshot.warnings.length > 0 && <p className="muted">{snapshot.warnings.join(' · ')}</p>}
      {live.wsStatus === 'reconnecting' && <p className="muted reconnect-banner">Reconnecting…</p>}
      <RunSummary snapshot={snapshot} busy={busy} roundStats={roundStats} />
      <div className="export-bar">
        <select
          value="-- export --"
          onChange={(e) => {
            const v = e.target.value
            if (v === 'json' || v === 'csv') {
              window.location.href = `/api/runs/${snapshot.runId}/export?format=${v}`
            }
          }}
        >
          <option value="-- export --">-- export --</option>
          <option value="json">JSON</option>
          <option value="csv">CSV</option>
        </select>
      </div>
      {!busy && snapshot.lastRoundIdx === 0 && <p className="muted">No rounds yet — set a goal and run round 1.</p>}
      <div className="layout" ref={gridRef} tabIndex={-1}>
        <AgentGrid agents={snapshot.agents} live={live} onSelect={setSelectedAgentId} />
        <aside>
          <RoundControls
            key={snapshot.runId}
            goal={snapshot.goalMd ?? 'Produce the best possible answer.'}
            busy={busy}
            starting={starting}
            roundIdx={activeRoundIdx}
            onRun={(goalMd, criteriaMd) => {
              if (!startGate.current.tryStart()) return
              // Exactly the visible draft, null when cleared: creation criteria reach
              // round 1 by being shown in the editor, never through a hidden fallback.
              setStarting(true)
              void startRound(snapshot.runId, goalMd, criteriaMd)
                .then(() => { void refresh(snapshot.runId) })
                .catch((e) => setError(serverError(e)))
                .finally(() => { startGate.current.finish(); setStarting(false) })
            }}
            criteria={criteriaDraftSeed(snapshot)}
            appliedCriteria={snapshot.lastRoundCriteria}
            criteriaSource={lastRound?.criteriaSource ?? null}
            metaDigest={lastRound?.metaDigest ?? null}
            rosterModels={[...new Set(snapshot.roster.map((r) => r.modelId))]}
            agents={snapshot.agents.map((a) => ({ agentId: a.agentId, label: a.label }))}
            onOverrideCriteria={(text) =>
              overrideCriteria(snapshot.runId, activeRoundIdx, text)
                .then(() => {
                  // Re-read so the applied view shows what the server now holds.
                  void refresh(snapshot.runId)
                  return { ok: true, message: `Override applied to round ${activeRoundIdx}.` }
                })
                .catch((e) => ({ ok: false, message: serverError(e) }))}
            onAddAgent={(input) =>
              createAgent(snapshot.runId, input)
                .then((r) => { void refresh(snapshot.runId); return { ok: true as const, message: `Added ${r.label}.` } })
                .catch((e) => ({ ok: false as const, message: serverError(e) }))}
            onAbort={() =>
              abortRound(snapshot.runId, activeRoundIdx)
                .then(() => 'Abort requested. Running agents are stopped; the round is marked failed.')
                .catch((e) => serverError(e))}
          />
          <h2 style={{ fontSize: '.9rem' }}>Leaderboard</h2>
          <Leaderboard agents={snapshot.agents} live={live} />
          {live.lastBreach && <p className="error">Budget: {live.lastBreach}</p>}
        </aside>
      </div>
      <AnalyticsPanel
        runId={snapshot.runId}
        agents={snapshot.agents}
        onOpenAgent={setSelectedAgentId}
        refreshKey={snapshot.lastRoundIdx}
      />
      <RoundDetail
        runId={snapshot.runId}
        rounds={roundStats}
        busy={busy}
        lastRoundIdx={activeRoundIdx}
        refreshKey={snapshot.lastRoundIdx}
      />
      {selectedAgentId && (
        <AgentDrawer
          runId={snapshot.runId}
          agentId={selectedAgentId}
          onClose={() => { setSelectedAgentId(null); gridRef.current?.focus() }}
          onRetired={() => { setSelectedAgentId(null); void refresh(snapshot.runId) }}
        />
      )}
    </>
  )
}
