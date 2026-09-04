import { useEffect, useState } from 'react'
import { Markdown } from './Markdown.js'
import type { AddAgentStrategy } from '../api.js'

export interface AddAgentFormInput {
  modelId: string
  temperature: number
  strategy: AddAgentStrategy
}

// Presentational: App owns every fetch; this component takes display data +
// callbacks. All new props are optional so existing usages keep compiling.
export function RoundControls({
  goal, busy, roundIdx, onRun,
  criteria, criteriaSource, metaDigest,
  rosterModels, agents,
  onOverrideCriteria, onAddAgent, onAbort,
}: {
  goal: string
  busy: boolean
  roundIdx: number
  onRun: (goalMd: string, criteriaMd: string | null) => void
  criteria?: string | null
  criteriaSource?: 'user' | 'generated' | null
  metaDigest?: string | null
  rosterModels?: string[]
  agents?: { agentId: string; label: string }[]
  onOverrideCriteria?: (text: string) => Promise<string | null>
  onAddAgent?: (input: AddAgentFormInput) => Promise<{ ok: boolean; message: string }>
  onAbort?: () => Promise<string | null>
}) {
  const [text, setText] = useState(goal)
  // Prefill arrives async (round-stats fetch), so sync when the prop changes.
  const [criteriaText, setCriteriaText] = useState(criteria ?? '')
  useEffect(() => { setCriteriaText(criteria ?? '') }, [criteria])
  const [overrideMsg, setOverrideMsg] = useState<string | null>(null)
  const [aborting, setAborting] = useState(false)
  const [abortMsg, setAbortMsg] = useState<string | null>(null)
  // The snapshot refresh shows idle when the in-flight round settles.
  useEffect(() => {
    if (!busy) { setAborting(false); setAbortMsg(null) }
  }, [busy])

  const [model, setModel] = useState('')
  const [temperature, setTemperature] = useState(0.7)
  const [mode, setMode] = useState<'blank' | 'pasted' | 'clone'>('blank')
  const [pastedText, setPastedText] = useState('')
  const [cloneId, setCloneId] = useState('')
  const [addMsg, setAddMsg] = useState<string | null>(null)

  const trimmedCriteria = criteriaText.trim()
  const models = rosterModels ?? []
  const agentList = agents ?? []
  const effectiveModel = model || models[0] || ''
  const effectiveClone = cloneId || agentList[0]?.agentId || ''

  const submitAgent = () => {
    if (!onAddAgent) return
    const strategy: AddAgentStrategy =
      mode === 'pasted' ? { mode: 'pasted', strategyMd: pastedText } :
      mode === 'clone' ? { mode: 'clone', agentId: effectiveClone } :
      { mode: 'blank' }
    if (mode === 'pasted' && pastedText.trim() === '') { setAddMsg('Strategy text is required for pasted mode.'); return }
    if (mode === 'clone' && !effectiveClone) { setAddMsg('Pick a clone source agent.'); return }
    setAddMsg(null)
    void onAddAgent({ modelId: effectiveModel, temperature, strategy }).then((r) => setAddMsg(r.message))
  }

  return (
    <div className="controls">
      <label htmlFor="goal">Goal for round {roundIdx + 1}</label>
      <textarea
        id="goal"
        value={text}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />
      <button onClick={() => onRun(text, trimmedCriteria === '' ? null : criteriaText)} disabled={busy || text.trim().length === 0}>
        {busy ? 'Round in progress…' : `Run round ${roundIdx + 1}`}
      </button>
      <label htmlFor="criteria">Judging criteria (empty = auto-generate from goal)</label>
      <textarea
        id="criteria"
        value={criteriaText}
        rows={3}
        placeholder="auto-generate from goal"
        onChange={(e) => setCriteriaText(e.target.value)}
      />
      {busy && onOverrideCriteria && (
        <>
          <button onClick={() => { void onOverrideCriteria(criteriaText).then(setOverrideMsg) }}>
            Override running round
          </button>
          <p className="muted">Best-effort: applies if judging hasn&apos;t started.</p>
          {overrideMsg && <p className="muted">{overrideMsg}</p>}
        </>
      )}
      {metaDigest != null && (
        <section className="digest">
          <h3>
            What separated winners from losers
            {criteriaSource && <span className={`badge badge--${criteriaSource}`}>{criteriaSource}</span>}
          </h3>
          <Markdown text={metaDigest} />
        </section>
      )}
      {onAddAgent && (
        <section className="add-agent">
          <h3>Add agent</h3>
          <label htmlFor="add-model">Model</label>
          <select id="add-model" value={effectiveModel} onChange={(e) => setModel(e.target.value)} disabled={busy}>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <label htmlFor="add-temp">Temperature</label>
          <input
            id="add-temp" type="number" min={0} max={2} step={0.1}
            value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} disabled={busy}
          />
          <div role="radiogroup" aria-label="Strategy mode" className="add-agent__modes">
            {(['blank', 'pasted', 'clone'] as const).map((m) => (
              <label key={m}>
                <input type="radio" name="add-mode" checked={mode === m} onChange={() => setMode(m)} disabled={busy} /> {m}
              </label>
            ))}
          </div>
          {mode === 'pasted' && (
            <textarea
              aria-label="Pasted strategy" rows={3} value={pastedText}
              onChange={(e) => setPastedText(e.target.value)} disabled={busy}
            />
          )}
          {mode === 'clone' && (
            <select aria-label="Clone source" value={effectiveClone} onChange={(e) => setCloneId(e.target.value)} disabled={busy}>
              {agentList.map((a) => <option key={a.agentId} value={a.agentId}>{a.label}</option>)}
            </select>
          )}
          <button onClick={submitAgent} disabled={busy || !effectiveModel}>Add agent</button>
          {addMsg && <p className="muted">{addMsg}</p>}
        </section>
      )}
      {busy && onAbort && (
        <>
          <button
            className="danger"
            disabled={aborting}
            onClick={() => {
              if (!window.confirm('Abort the running round? Abort requested. Running agents are stopped; the round is marked failed.')) return
              setAborting(true)
              setAbortMsg(null)
              void onAbort().then((m) => setAbortMsg(m))
            }}
          >
            {aborting ? 'Aborting…' : 'Abort round'}
          </button>
          {abortMsg && <p className="muted">{abortMsg}</p>}
        </>
      )}
    </div>
  )
}
