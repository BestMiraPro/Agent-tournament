import { useCallback, useEffect, useState } from 'react'
import './styles.css'
import { abortRound, createAgent, createRunFull, deleteRun, getRoundStats, getRun, overrideCriteria, serverError, startRound, type FullRunSpec, type RoundStats, type RunSnapshot } from './api.js'
import { parsePricing } from './lib/pricing.js'
import { summarizeRoster } from './lib/roster.js'
import { useLiveRun } from './useLiveRun.js'
import { AgentDrawer } from './components/AgentDrawer.js'
import { AnalyticsPanel } from './components/AnalyticsPanel.js'
import { RoundDetail } from './components/RoundDetail.js'
import { RunSummary } from './components/RunSummary.js'
import { AgentGrid } from './components/AgentGrid.js'
import { Leaderboard } from './components/Leaderboard.js'
import { RoundControls } from './components/RoundControls.js'
import { RunSetup, type RunSetupValue } from './components/RunSetup.js'

export function App() {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null)
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
  // Setup criteria is a single-session default for round 1 only — rounds own
  // criteria after that, so a reload before round 1 loses it (no persistence).
  const [pendingCriteria, setPendingCriteria] = useState<string | null>(null)
  const live = useLiveRun(snapshot)

  const refresh = useCallback(async (runId: string) => {
    try {
      setSnapshot(await getRun(runId))
    } catch (e) {
      setError(serverError(e))
    }
  }, [])

  const handleCreate = useCallback(async (value: RunSetupValue) => {
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
      const parsed = parsePricing(value.pricingText)
      if (parsed.error) throw new Error(parsed.error)
      pricing = parsed.pricing ?? {}
    } catch (e) {
      setSetupError(serverError(e))
      return
    }
    setCreating(true)
    setSetupError(null)
    let runId: string
    try {
      ;({ runId } = await createRunFull({
        name: value.name.trim(),
        goal: value.goal.trim(),
        sandbox: value.sandbox,
        roster,
        workspaceRoot: value.workspaceRoot.trim() || null,
        authFile: value.authFile.trim() || null,
        criteria: value.criteria,
        selection: value.selection,
        concurrency: value.concurrency,
        pricing,
      }))
    } catch (e) {
      setSetupError(serverError(e))
      setCreating(false)
      return
    }
    setPendingCriteria(value.criteria)
    try {
      setSnapshot(await getRun(runId))
    } catch {
      // The run exists on the server; a failed first read should not look like a clean form.
      setSetupError(`Run created, but loading it failed - reload the page.`)
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

  if (!snapshot) {
    return (
      <>
        <h1>Agent Tournament — new run</h1>
        <RunSetup busy={creating} error={setupError} onCreate={handleCreate} />
      </>
    )
  }

  if (error) return <p className="error">{error}</p>

  const busy = live.busy || snapshot.busy

  return (
    <>
      <div className="arena-head">
        <h1>Agent Tournament — {snapshot.name}</h1>
        {!stopped && (
          <button className="stop" disabled={stopping} onClick={() => handleStop(snapshot.runId)}>
            {stopping ? 'Stopping…' : 'Stop run'}
          </button>
        )}
      </div>
      {stopped && <p className="muted">Run stopped.</p>}
      {stopError && <p className="error">{stopError}</p>}
      {snapshot.warnings.length > 0 && <p className="muted">{snapshot.warnings.join(' · ')}</p>}
      <RunSummary snapshot={snapshot} busy={busy} roundStats={roundStats} />
      <div className="layout">
        <AgentGrid agents={snapshot.agents} live={live} onSelect={setSelectedAgentId} />
        <aside>
          <RoundControls
            goal={snapshot.goalMd ?? 'Produce the best possible answer.'}
            busy={busy}
            roundIdx={snapshot.lastRoundIdx}
            onRun={(goalMd, criteriaMd) => {
              // First round after a setup-created run carries the setup
              // criteria (blank = null = auto-generate); an explicit
              // RoundControls entry always wins, and later rounds fall back to
              // null/auto — the RoundControls path below is untouched.
              const first = pendingCriteria?.trim() ? pendingCriteria : null
              void startRound(snapshot.runId, goalMd, criteriaMd ?? first).then(() => setPendingCriteria(null)).catch((e) => setError(serverError(e)))
            }}
            criteria={lastRound?.criteriaMd ?? null}
            criteriaSource={lastRound?.criteriaSource ?? null}
            metaDigest={lastRound?.metaDigest ?? null}
            rosterModels={[...new Set(snapshot.roster.map((r) => r.modelId))]}
            agents={snapshot.agents.map((a) => ({ agentId: a.agentId, label: a.label }))}
            onOverrideCriteria={(text) =>
              overrideCriteria(snapshot.runId, snapshot.lastRoundIdx, text)
                .then(() => 'Criteria override recorded.')
                .catch((e) => serverError(e))}
            onAddAgent={(input) =>
              createAgent(snapshot.runId, input)
                .then((r) => { void refresh(snapshot.runId); return { ok: true as const, message: `Added ${r.label}.` } })
                .catch((e) => ({ ok: false as const, message: serverError(e) }))}
            onAbort={() =>
              abortRound(snapshot.runId, snapshot.lastRoundIdx)
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
        lastRoundIdx={snapshot.lastRoundIdx}
        refreshKey={snapshot.lastRoundIdx}
      />
      {selectedAgentId && (
        <AgentDrawer
          runId={snapshot.runId}
          agentId={selectedAgentId}
          onClose={() => setSelectedAgentId(null)}
          onRetired={() => { setSelectedAgentId(null); void refresh(snapshot.runId) }}
        />
      )}
    </>
  )
}
