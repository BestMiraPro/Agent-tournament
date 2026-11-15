import { useCallback, useEffect, useState } from 'react'
import {
  addConnector,
  importConnector,
  listConnectors,
  listImportable,
  removeConnector,
  serverError,
  startConnectorSignIn,
  testConnector,
  updateConnector,
  type ConnectorInfo,
  type ConnectorList,
  type ConnectorPreset,
  type ImportableServer,
} from '../api.js'
import { statusLabel, togglePolicy, toolRowsFor, type ToolRowView } from '../lib/connectors.js'

/** Each tool the last test listed. Read tools can be switched off, write tools permitted; locked tools cannot change. */
export function ToolTable({ rows, busy, onToggle }: { rows: ToolRowView[]; busy: boolean; onToggle: (row: ToolRowView) => void }) {
  if (rows.length === 0) return <p className="help">No tools listed yet — use Test connection.</p>
  return (
    <table className="runbrowser connector-tools">
      <thead><tr><th>Tool</th><th>Agents</th><th>What it does</th></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name} className={row.classification === 'locked' ? 'connector-tools__locked' : undefined}>
            <td><code>{row.name}</code></td>
            <td>
              <label>
                <input type="checkbox" checked={row.on} disabled={busy || !row.editable} onChange={() => onToggle(row)} />{' '}
                {row.note}
              </label>
            </td>
            <td className="muted">{row.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function ConnectorCard({ connector, busy, onChange, onError }: {
  connector: ConnectorInfo
  busy: boolean
  onChange: (next: ConnectorInfo | null) => void
  onError: (message: string | null) => void
}) {
  const [token, setToken] = useState('')
  const [working, setWorking] = useState(false)
  const run = async (fn: () => Promise<ConnectorInfo | null | void>) => {
    setWorking(true)
    onError(null)
    try {
      const next = await fn()
      if (next !== undefined) onChange(next)
    } catch (e) {
      onError(`${connector.title}: ${serverError(e)}`)
    } finally {
      setWorking(false)
    }
  }
  const disabled = busy || working
  const signs = connector.kind === 'gmail' || connector.auth.type === 'oauth-mcp'
  const manualToken = connector.auth.type === 'token' && connector.auth.source === 'manual'
  return (
    <section className="connector" aria-labelledby={`connector-${connector.id}`}>
      <h2 id={`connector-${connector.id}`}>{connector.title} <code>{connector.id}</code></h2>
      <p className="help">
        {connector.kind === 'custom' ? (connector.origin.type === 'imported' ? `Imported from Claude Code (${connector.origin.name})` : 'Custom') : connector.kind}
        {' · '}{statusLabel(connector)}
        {connector.locked && ' · read-only, locked: search, read and list only — no setting enables writing'}
        {connector.secretsSet.length > 0 && ` · credentials stored: ${connector.secretsSet.join(', ')}`}
      </p>
      <div className="connector__actions">
        <button disabled={disabled} onClick={() => run(async () => (await testConnector(connector.id)).connector ?? null)}>Test connection</button>
        {signs && (
          <button disabled={disabled} onClick={() => run(async () => {
            const r = await startConnectorSignIn(connector.id)
            if (r.authorizationUrl) window.open(r.authorizationUrl, '_blank', 'noopener')
          })}>Connect (sign in)</button>
        )}
        <button disabled={disabled} onClick={() => run(async () => {
          if (!window.confirm(`Delete the ${connector.title} connector and its stored credentials? Runs that use it will be refused.`)) return
          await removeConnector(connector.id)
          return null
        })}>Delete</button>
      </div>
      {manualToken && (
        <div className="connector__token">
          <label htmlFor={`token-${connector.id}`}>Replace token</label>
          <input id={`token-${connector.id}`} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} disabled={disabled} />
          <button disabled={disabled || token.trim() === ''} onClick={() => run(async () => {
            const next = (await updateConnector(connector.id, { token: token.trim() })).connector
            setToken('')
            return next
          })}>Save token</button>
        </div>
      )}
      <ToolTable
        rows={toolRowsFor(connector)}
        busy={disabled}
        onToggle={(row) => run(async () => (await updateConnector(connector.id, { policy: togglePolicy(connector.policy, row) })).connector)}
      />
    </section>
  )
}

type PresetKind = ConnectorPreset['preset']

/** The add-a-connector form: one preset at a time, credentials typed once and stored host-side only. */
export function AddConnectorForm({ busy, onAdded, onError }: { busy: boolean; onAdded: (c: ConnectorInfo) => void; onError: (m: string | null) => void }) {
  const [preset, setPreset] = useState<PresetKind>('github')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const set = (key: string) => (e: { target: { value: string } }) => setFields((f) => ({ ...f, [key]: e.target.value }))
  const v = (key: string) => (fields[key] ?? '').trim()
  const field = (key: string, label: string, opts: { secret?: boolean; placeholder?: string } = {}) => (
    <>
      <label htmlFor={`add-${key}`}>{label}</label>
      <input id={`add-${key}`} type={opts.secret ? 'password' : 'text'} autoComplete="off" value={fields[key] ?? ''} placeholder={opts.placeholder} onChange={set(key)} disabled={busy || saving} />
    </>
  )
  const body = (): ConnectorPreset => {
    const id = v('id') || undefined
    switch (preset) {
      case 'github':
        return { preset, id, mode: v('mode') === 'local' ? 'local' : 'remote', tokenSource: v('tokenSource') === 'gh-cli' ? 'gh-cli' : 'manual', ...(v('token') ? { token: v('token') } : {}) }
      case 'slack':
        return { preset, id, token: v('token') }
      case 'gmail':
        return { preset, id, clientId: v('clientId'), clientSecret: v('clientSecret') }
      case 'remote':
        return { preset, id: v('id'), url: v('url'), ...(v('token') ? { bearerToken: v('token') } : {}) }
      case 'local':
        return { preset, id: v('id'), command: v('command'), args: v('args') ? v('args').split(/\s+/) : [] }
    }
  }
  return (
    <section className="setup" aria-labelledby="add-connector">
      <h2 id="add-connector">Add a connector</h2>
      <label htmlFor="add-preset">Kind</label>
      <select id="add-preset" value={preset} onChange={(e) => { setPreset(e.target.value as PresetKind); setFields({}) }} disabled={busy || saving}>
        <option value="github">GitHub (official GitHub MCP server)</option>
        <option value="slack">Slack (read-only, locked)</option>
        <option value="gmail">Gmail (read-only, locked)</option>
        <option value="remote">Remote MCP server (URL)</option>
        <option value="local">Local MCP server (command)</option>
      </select>
      {field('id', 'Connector id (optional for presets)', { placeholder: preset === 'remote' || preset === 'local' ? 'my-server' : preset })}
      {preset === 'github' && (
        <>
          <label htmlFor="add-mode">Server</label>
          <select id="add-mode" value={fields.mode ?? 'remote'} onChange={set('mode')} disabled={busy || saving}>
            <option value="remote">GitHub&apos;s remote server (api.githubcopilot.com)</option>
            <option value="local">Local github-mcp-server binary</option>
          </select>
          <label htmlFor="add-tokenSource">Token</label>
          <select id="add-tokenSource" value={fields.tokenSource ?? 'manual'} onChange={set('tokenSource')} disabled={busy || saving}>
            <option value="manual">A personal access token I paste</option>
            <option value="gh-cli">Read `gh auth token` each time a run starts</option>
          </select>
          {(fields.tokenSource ?? 'manual') === 'manual' && field('token', 'Personal access token', { secret: true })}
          <p className="help">Read-only by default: GitHub is asked for read-only mode until you permit a write tool.</p>
        </>
      )}
      {preset === 'slack' && (
        <>
          {field('token', 'Slack user token (xoxp-…)', { secret: true })}
          <p className="help">Search, read and list only. Sending, posting, replying, reacting, scheduling and deleting are not available and cannot be enabled.</p>
        </>
      )}
      {preset === 'gmail' && (
        <>
          {field('clientId', 'Google OAuth client ID (desktop app)')}
          {field('clientSecret', 'Google OAuth client secret', { secret: true })}
          <p className="help">Scope gmail.readonly only. After adding, choose Connect to sign in. Sending, drafting, labelling and deleting are not available and cannot be enabled.</p>
        </>
      )}
      {preset === 'remote' && (
        <>
          {field('url', 'Server URL', { placeholder: 'https://example.com/mcp' })}
          {field('token', 'Bearer token (optional; leave blank to sign in with OAuth if the server asks)', { secret: true })}
        </>
      )}
      {preset === 'local' && (
        <>
          {field('command', 'Command', { placeholder: 'npx' })}
          {field('args', 'Arguments (space-separated)', { placeholder: '-y some-mcp-server' })}
        </>
      )}
      <button disabled={busy || saving} onClick={async () => {
        setSaving(true)
        onError(null)
        try {
          onAdded((await addConnector(body())).connector)
          setFields({})
        } catch (e) {
          onError(serverError(e))
        } finally {
          setSaving(false)
        }
      }}>{saving ? 'Adding…' : 'Add connector'}</button>
    </section>
  )
}

export function ImportList({ servers, busy, onImport }: { servers: ImportableServer[]; busy: boolean; onImport: (s: ImportableServer) => void }) {
  if (servers.length === 0) return <p className="help">No MCP servers were found in Claude Code&apos;s configuration on this machine.</p>
  return (
    <table className="runbrowser">
      <thead><tr><th>Server</th><th>From</th><th>Runs</th><th /></tr></thead>
      <tbody>
        {servers.map((s) => (
          <tr key={s.key}>
            <td><strong>{s.name}</strong></td>
            <td className="muted">{s.from}</td>
            <td className="muted"><code>{s.transport.type === 'http' ? s.transport.url : [s.transport.command, ...s.transport.args].join(' ')}</code></td>
            <td>{s.imported ? <span className="muted">imported</span> : <button disabled={busy} onClick={() => onImport(s)}>Import as {s.suggestedId}</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function Connectors() {
  const [list, setList] = useState<ConnectorList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importable, setImportable] = useState<ImportableServer[] | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(() => {
    listConnectors().then(setList, (e) => setError(serverError(e)))
  }, [])
  useEffect(() => { refresh() }, [refresh])
  // A sign-in finishes in another tab; pick it up when this one is looked at again.
  useEffect(() => {
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  if (!list) return <p className={error ? 'error' : 'muted'}>{error ?? 'Loading connectors…'}</p>
  return (
    <div className="connectors">
      <p className="help">
        Connectors give agents tools from GitHub, Slack, Gmail and other MCP servers. The dashboard holds every credential;
        agents only get a per-run token for the tool bridge, which records each call. Slack and Gmail are read-only and locked.
        Other connectors expose read-only tools unless you permit a write tool here and a run opts into it.
      </p>
      {error && <p className="error">{error}</p>}
      {!list.store && <p className="error">This dashboard was started without a connector store, so connectors cannot be added.</p>}
      {list.connectors.map((c) => (
        <ConnectorCard key={c.id} connector={c} busy={busy} onError={setError}
          onChange={(next) => setList((l) => l && ({
            ...l,
            connectors: next === null ? l.connectors.filter((x) => x.id !== c.id) : l.connectors.map((x) => (x.id === c.id ? next : x)),
          }))} />
      ))}
      {list.builtins.length > 0 && (
        <section aria-labelledby="builtin-connectors">
          <h2 id="builtin-connectors">Built in</h2>
          <ul>{list.builtins.map((b) => <li key={b.id}><strong>{b.title}</strong> <code>{b.id}</code> — read-only{b.description ? `. ${b.description}` : ''}</li>)}</ul>
        </section>
      )}
      {list.store && (
        <>
          <AddConnectorForm busy={busy} onError={setError} onAdded={(c) => setList((l) => l && ({ ...l, connectors: [...l.connectors, c] }))} />
          <section aria-labelledby="import-connectors">
            <h2 id="import-connectors">Import from Claude Code</h2>
            <p className="help">
              Reads ~/.claude.json, ~/.claude/settings.json, project .mcp.json files and plugin .mcp.json files, without changing them.
              Connectors hosted by claude.ai (its Gmail, Slack, GitHub, Drive …) cannot be imported: their sign-ins belong to claude.ai. Use the presets above instead.
            </p>
            <button disabled={busy} onClick={() => listImportable().then((r) => setImportable(r.servers), (e) => setError(serverError(e)))}>Find Claude Code servers</button>
            {importable && (
              <ImportList servers={importable} busy={busy} onImport={async (s) => {
                setBusy(true)
                setError(null)
                try {
                  const { connector } = await importConnector(s.key)
                  setList((l) => l && ({ ...l, connectors: [...l.connectors, connector] }))
                  setImportable((all) => all?.map((x) => (x.key === s.key ? { ...x, imported: true } : x)) ?? null)
                } catch (e) {
                  setError(serverError(e))
                } finally {
                  setBusy(false)
                }
              }} />
            )}
          </section>
        </>
      )}
    </div>
  )
}
