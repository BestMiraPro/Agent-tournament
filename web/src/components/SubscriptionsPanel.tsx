import { useState } from 'react'
import { clearClaudeToken, serverError, setClaudeToken, type SubscriptionStatus } from '../api.js'
import { subscriptionSummary } from '../lib/subscriptions.js'

// Sign-in for the two subscriptions. The token box is write-only: the server only ever says
// whether a token is set, and the field clears once it is saved.
export function SubscriptionsPanel({ status, onChange, disabled }: {
  status: SubscriptionStatus | null
  onChange: (next: SubscriptionStatus) => void
  disabled?: boolean
}) {
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (action: () => Promise<SubscriptionStatus>) => {
    setSaving(true)
    setError(null)
    try {
      onChange(await action())
      setToken('')
    } catch (e) {
      setError(serverError(e))
    } finally {
      setSaving(false)
    }
  }

  const summary = status ? subscriptionSummary(status) : null
  const usage = status?.claude.usage
  return (
    <div className="subscriptions">
      {summary === null ? (
        <p className="muted">Subscription status is not available from this server.</p>
      ) : (
        <>
          <p className="help">{summary.claude}{status!.claude.cli.version ? ` (Claude Code ${status!.claude.cli.version})` : ''}</p>
          {usage && usage.status === 'rejected' && (
            <p className="error">
              Claude usage limit reached{usage.resetsAt ? `; resets ${new Date(usage.resetsAt * 1000).toLocaleString()}` : ''}. Claude agents fail at once until then.
            </p>
          )}
          <p className="help">{summary.chatgpt}</p>
        </>
      )}
      <label htmlFor="setup-claude-token">Claude setup token</label>
      <input
        id="setup-claude-token"
        type="password"
        autoComplete="off"
        value={token}
        placeholder={status?.claude.tokenSet ? 'saved — paste a new one to replace it' : 'paste the output of claude setup-token'}
        onChange={(e) => setToken(e.target.value)}
        disabled={disabled || saving}
      />
      <button onClick={() => save(() => setClaudeToken(token))} disabled={disabled || saving || token.trim() === ''}>Save token</button>
      {status?.claude.tokenSet && (
        <button onClick={() => save(clearClaudeToken)} disabled={disabled || saving}>Remove token</button>
      )}
      {error && <p className="error">{error}</p>}
      <p className="help">
        Claude Pro/Max: run <code>claude setup-token</code> and paste what it prints (kept on this machine only, never shown again).
        Without a token, local runs use this machine&apos;s own <code>claude auth login</code>. Pick <code>claude-subscription/…</code> models.
      </p>
      <p className="help">
        ChatGPT Plus/Pro: run <code>opencode auth login</code>, choose OpenAI, then ChatGPT Plus/Pro. Its <code>openai/…</code> models then bill the subscription.
      </p>
    </div>
  )
}
