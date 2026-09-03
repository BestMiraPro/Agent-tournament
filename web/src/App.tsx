import { useCallback, useEffect, useState } from 'react'
import './styles.css'
import { createRun, getRun, startRound, type RunSnapshot } from './api.js'
import { useLiveRun } from './useLiveRun.js'
import { AgentGrid } from './components/AgentGrid.js'
import { Leaderboard } from './components/Leaderboard.js'
import { RoundControls } from './components/RoundControls.js'

export function App() {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const live = useLiveRun(snapshot)

  const refresh = useCallback(async (runId: string) => {
    try {
      setSnapshot(await getRun(runId))
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const { runId } = await createRun('dashboard', 'Produce the best possible answer.')
        await refresh(runId)
      } catch (e) {
        setError(String(e))
      }
    })()
  }, [refresh])

  // A finished round changes the roster and the scores, so re-read the snapshot.
  useEffect(() => {
    if (!snapshot) return
    if (live.busy) return
    if (live.roundIdx === 0) return
    void refresh(snapshot.runId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.busy, live.roundIdx])

  if (error) return <p className="error">{error}</p>
  if (!snapshot) return <p className="muted">Starting…</p>

  const busy = live.busy || snapshot.busy

  return (
    <>
      <h1>Agent Tournament — {snapshot.name}</h1>
      <div className="layout">
        <AgentGrid agents={snapshot.agents} live={live} />
        <aside>
          <RoundControls
            goal={snapshot.goalMd ?? 'Produce the best possible answer.'}
            busy={busy}
            roundIdx={snapshot.lastRoundIdx}
            onRun={(goalMd) => {
              void startRound(snapshot.runId, goalMd).catch((e) => setError(String(e)))
            }}
          />
          <h2 style={{ fontSize: '.9rem' }}>Leaderboard</h2>
          <Leaderboard agents={snapshot.agents} live={live} />
          {live.lastBreach && <p className="error">Budget: {live.lastBreach}</p>}
        </aside>
      </div>
    </>
  )
}
