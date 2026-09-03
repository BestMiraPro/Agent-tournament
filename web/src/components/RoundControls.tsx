import { useState } from 'react'

export function RoundControls({
  goal, busy, roundIdx, onRun,
}: {
  goal: string
  busy: boolean
  roundIdx: number
  onRun: (goalMd: string) => void
}) {
  const [text, setText] = useState(goal)

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
      <button onClick={() => onRun(text)} disabled={busy || text.trim().length === 0}>
        {busy ? 'Round in progress…' : `Run round ${roundIdx + 1}`}
      </button>
    </div>
  )
}
