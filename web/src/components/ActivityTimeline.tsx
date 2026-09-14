import { useEffect, useRef, useState } from 'react'
import type { ActivityItem } from '../api.js'

const KIND_LABEL: Record<ActivityItem['kind'], string> = {
  text: 'Message',
  tool: 'Tool',
  file: 'File',
  permission: 'Permission',
  error: 'Error',
}

/**
 * An agent's public activity for the current round, rendered as plain text.
 *
 * Every string here came from an agent or a model, so nothing is rendered as HTML. The list
 * is a log that does not announce each streamed update to screen readers, and it follows new
 * entries only while the viewer is already at the bottom; otherwise it offers a button.
 */
export function ActivityTimeline({ items, truncated, unavailable }: {
  items: ActivityItem[]
  truncated: boolean
  /** The server holds no live history for this run, e.g. after it restarted. */
  unavailable: boolean
}) {
  const listRef = useRef<HTMLOListElement>(null)
  const atBottom = useRef(true)
  const [unseen, setUnseen] = useState(false)
  const latestRevision = items.reduce((max, i) => Math.max(max, i.revision), 0)

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    if (atBottom.current) list.scrollTop = list.scrollHeight
    else setUnseen(true)
  }, [latestRevision])

  if (items.length === 0) {
    return (
      <p className="muted">
        {unavailable
          ? 'Live activity from before the server restarted is not available; saved results are shown below.'
          : 'No live activity received yet.'}
      </p>
    )
  }

  const jumpToLatest = () => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
    atBottom.current = true
    setUnseen(false)
  }

  return (
    <div className="timeline">
      {truncated && <p className="muted">Older activity was dropped to stay within the live activity limit.</p>}
      <ol
        ref={listRef}
        className="timeline__list"
        role="log"
        aria-live="off"
        aria-label="Live activity"
        tabIndex={0}
        onScroll={(e) => {
          const list = e.currentTarget
          atBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24
          if (atBottom.current) setUnseen(false)
        }}
      >
        {items.map((item) => (
          <li key={item.id} className={`timeline__item timeline__item--${item.kind}`}>
            <span className="timeline__kind">{KIND_LABEL[item.kind] ?? item.kind}</span>
            {item.status && (
              <span className={`timeline__status timeline__status--${item.status}`}>
                {item.status === 'waiting' ? 'Waiting for permission' : item.status}
              </span>
            )}
            <span className="timeline__summary">{item.summary}</span>
            {item.output !== undefined && item.output !== '' && (
              <details className="timeline__output">
                <summary>Output</summary>
                <pre>{item.output}</pre>
              </details>
            )}
            {item.truncated && <span className="muted">Output truncated</span>}
          </li>
        ))}
      </ol>
      {unseen && (
        <button type="button" className="timeline__new" onClick={jumpToLatest}>New activity</button>
      )}
    </div>
  )
}
