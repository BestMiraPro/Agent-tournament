import { useId } from 'react'
import { summarizeRoster, type RosterEntry } from '../lib/roster.js'

// Controlled: the parent owns the array, this renders rows. Unknown model ids
// pass through untouched — the datalist is a picker aid, the server validates.
export function RosterBuilder({ value, onChange, models, disabled }: {
  value: RosterEntry[]
  onChange: (v: RosterEntry[]) => void
  models: string[]
  disabled?: boolean
}) {
  const listId = useId()
  const { total, errors } = summarizeRoster(value)

  const update = (idx: number, patch: Partial<RosterEntry>) => {
    onChange(value.map((entry, i) => (i === idx ? { ...entry, ...patch } : entry)))
  }

  return (
    <div>
      {value.map((entry, i) => (
        <div key={i} className="roster-row">
          <label htmlFor={`roster-model-${i}`}>Model</label>
          <input
            id={`roster-model-${i}`}
            type="text"
            value={entry.modelId}
            list={listId}
            onChange={(e) => update(i, { modelId: e.target.value })}
            disabled={disabled}
          />
          <label htmlFor={`roster-count-${i}`}>Count</label>
          <input
            id={`roster-count-${i}`} type="number" min={1} step={1}
            value={entry.count}
            // NaN passes through unclamped: summarizeRoster is the single
            // source of truth for errors, this component never invents its own.
            onChange={(e) => update(i, { count: e.target.value === '' ? NaN : Number(e.target.value) })}
            disabled={disabled}
          />
          <label htmlFor={`roster-temp-${i}`}>Temp</label>
          <input
            id={`roster-temp-${i}`} type="number" min={0} max={2} step={0.1}
            value={entry.temperature}
            onChange={(e) => update(i, { temperature: e.target.value === '' ? NaN : Number(e.target.value) })}
            disabled={disabled}
          />
          <button onClick={() => onChange(value.filter((_, j) => j !== i))} disabled={disabled || value.length === 1}>
            Remove
          </button>
        </div>
      ))}
      <datalist id={listId}>
        {models.map((m) => <option key={m} value={m} />)}
      </datalist>
      <button
        onClick={() => onChange([...value, { modelId: '', count: 1, temperature: 0.7 }])}
        disabled={disabled}
      >
        Add row
      </button>
      <p className="muted">Total agents: {total}</p>
      {errors.map((e) => <p key={e} className="error">{e}</p>)}
    </div>
  )
}
