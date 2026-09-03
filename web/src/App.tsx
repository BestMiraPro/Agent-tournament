import { useCallback, useEffect, useState } from 'react'
import './styles.css'
import { createRunFull, getRun, startRound, type FullRunSpec, type RunSnapshot } from './api.js'
import { useLiveRun } from './useLiveRun.js'
import { AgentGrid } from './components/AgentGrid.js'
import { Leaderboard } from './components/Leaderboard.js'
import { RoundControls } from './components/RoundControls.js'
import { RunSetup, type RunSetupValue } from './components/RunSetup.js'

// One `modelId x<count> @<temperature>` per line; the temperature is optional
// and defaults to 0.7 (the codebase-wide default temperature).
const ROSTER_LINE = /^(.+?)\s+x(\d+)(?:\s*@(\d+(?:\.\d+)?))?$/

function parseRoster(text: string): FullRunSpec['roster'] {
  const roster: FullRunSpec['roster'] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? ''
    if (!line) continue
    const m = ROSTER_LINE.exec(line)
    if (!m || !m[1] || !m[2]) {
      throw new Error(`Roster line ${i + 1} must look like \`model xN @temp\`: ${line}`)
    }
    roster.push({
      modelId: m[1].trim(),
      count: Number(m[2]),
      temperature: m[3] === undefined ? 0.7 : Number(m[3]),
    })
  }
  return roster
}

// The shared `json` helper throws `"<status> <body>"`; surface the server's error field.
function serverError(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e)
  try {
    const parsed = JSON.parse(s.replace(/^\d+ /, '')) as { error?: string }
    if (parsed.error) return parsed.error
  } catch {
    /* body is not json; show the raw message */
  }
  return s
}

export function App() {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)
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
    try {
      roster = parseRoster(value.rosterText)
      if (roster.length === 0) throw new Error('Roster is empty - add at least one line.')
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
      }))
    } catch (e) {
      setSetupError(serverError(e))
      setCreating(false)
      return
    }
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
      <h1>Agent Tournament — {snapshot.name}</h1>
      {snapshot.warnings.length > 0 && <p className="muted">{snapshot.warnings.join(' · ')}</p>}
      <div className="layout">
        <AgentGrid agents={snapshot.agents} live={live} />
        <aside>
          <RoundControls
            goal={snapshot.goalMd ?? 'Produce the best possible answer.'}
            busy={busy}
            roundIdx={snapshot.lastRoundIdx}
            onRun={(goalMd) => {
              void startRound(snapshot.runId, goalMd).catch((e) => setError(serverError(e)))
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
