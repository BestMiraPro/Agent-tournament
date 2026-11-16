import { useEffect, useState } from 'react'
import { getRoundChannel, postToTeam, serverError, type ChannelMessage } from '../api.js'
import { channelHeader } from '../lib/team.js'

/** The entries themselves: author, target, time and body, oldest first. */
export function ChannelList({ messages }: { messages: ChannelMessage[] }) {
  if (messages.length === 0) return <p className="muted">No posts yet.</p>
  return (
    <ol className="channel__list">
      {messages.map((m) => (
        <li key={m.seq} className="channel__entry">
          <div className="channel__head">{channelHeader(m)}</div>
          <div className="channel__body">{m.body}</div>
        </li>
      ))}
    </ol>
  )
}

/** The operator's box for a running round: the post is signed `operator` and forwarded to every agent still working. */
export function OperatorPost({ runId }: { runId: string }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = async () => {
    setSending(true)
    setError(null)
    try {
      await postToTeam(runId, text.trim())
      setText('')
    } catch (e) {
      setError(serverError(e))
    } finally {
      setSending(false)
    }
  }
  return (
    <form className="channel__post" onSubmit={(e) => { e.preventDefault(); void send() }}>
      <label htmlFor="channel-post">Message the team</label>
      <textarea
        id="channel-post"
        rows={2}
        maxLength={4000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={sending}
        placeholder="Signed operator. Every agent still working gets it after its current step."
      />
      <button type="submit" disabled={sending || text.trim() === ''}>Post to the team</button>
      {error && <p className="error">{error}</p>}
    </form>
  )
}

/**
 * The team channel for the latest round: live posts while it runs, the recorded ones after.
 * Earlier rounds stay in CHANNEL.md for the team and in each round's channel endpoint.
 */
export function ChannelPanel({ runId, roundIdx, live, liveMessages }: {
  runId: string
  roundIdx: number
  /** True while this round is running and its posts arrive over the socket. */
  live: boolean
  liveMessages: ChannelMessage[]
}) {
  const [recorded, setRecorded] = useState<ChannelMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (live || roundIdx < 1) return
    let alive = true
    getRoundChannel(runId, roundIdx).then(
      (r) => { if (alive) { setRecorded(r.messages); setError(null) } },
      (e) => { if (alive) { setRecorded(null); setError(serverError(e)) } },
    )
    return () => { alive = false }
  }, [runId, roundIdx, live])
  const messages = live ? liveMessages : recorded ?? liveMessages
  return (
    <section className="channel" aria-labelledby="channel-h">
      <h2 id="channel-h" style={{ fontSize: '.9rem' }}>Team channel{roundIdx > 0 ? ` — round ${roundIdx}` : ''}</h2>
      {error && <p className="error">{error}</p>}
      <ChannelList messages={messages} />
      {live && <OperatorPost runId={runId} />}
    </section>
  )
}
