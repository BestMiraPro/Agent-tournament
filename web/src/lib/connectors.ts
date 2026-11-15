import type { ConnectorInfo, ConnectorList, ConnectorToolRow } from '../api.js'

export interface ToolRowView {
  name: string
  description: string
  classification: ConnectorToolRow['classification']
  /** Read: exposed to agents. Write: permitted (runs may opt in). Locked: never. */
  on: boolean
  editable: boolean
  note: string
}

/** One row per tool the last connection test listed: what agents get, and what the operator may change. */
export function toolRowsFor(c: ConnectorInfo): ToolRowView[] {
  return (c.tools ?? []).map((t) => {
    if (t.classification === 'locked') {
      return { name: t.name, description: t.description, classification: t.classification, on: false, editable: false, note: 'locked: this connector is read-only, so this tool is never exposed' }
    }
    if (t.classification === 'write') {
      const on = c.policy.writeTools.includes(t.name)
      return { name: t.name, description: t.description, classification: t.classification, on, editable: true, note: on ? 'write: permitted — each run must still opt in' : 'write: off' }
    }
    const on = !c.policy.disabledTools.includes(t.name)
    return { name: t.name, description: t.description, classification: t.classification, on, editable: true, note: on ? 'read: exposed to agents' : 'read: switched off' }
  })
}

/** The policy after the operator flips one row. Locked rows never change anything. */
export function togglePolicy(policy: ConnectorInfo['policy'], row: ToolRowView): ConnectorInfo['policy'] {
  if (!row.editable) return policy
  const flip = (list: string[]) => (list.includes(row.name) ? list.filter((n) => n !== row.name) : [...list, row.name])
  return row.classification === 'write'
    ? { ...policy, writeTools: flip(policy.writeTools) }
    : { ...policy, disabledTools: flip(policy.disabledTools) }
}

export function statusLabel(c: ConnectorInfo): string {
  if (c.connected) return c.toolsCheckedAt ? 'connected' : 'ready — test the connection to list its tools'
  if (c.kind === 'gmail' || c.auth.type === 'oauth-mcp') return 'needs sign-in'
  return 'needs a token'
}

export interface PickerChoice {
  id: string
  title: string
  builtin: boolean
  locked: boolean
  connected: boolean
  /** Write tools the connector permits, which a run may opt into. */
  permittedWriteTools: string[]
}

export function pickerChoices(list: ConnectorList | null): PickerChoice[] {
  if (!list) return []
  return [
    ...list.builtins.map((b) => ({ id: b.id, title: b.title, builtin: true, locked: true, connected: true, permittedWriteTools: [] })),
    ...list.connectors.map((c) => ({
      id: c.id, title: c.title, builtin: false, locked: c.locked, connected: c.connected,
      permittedWriteTools: c.locked ? [] : [...c.policy.writeTools],
    })),
  ]
}

export type PickerState = Record<string, { enabled: boolean; writeTools: string[] }>

/** What the run spec sends: enabled connectors, with only the write tools still permitted. */
export function runConnectorsFrom(state: PickerState, choices: readonly PickerChoice[]): { id: string; writeTools: string[] }[] {
  return choices
    .filter((c) => state[c.id]?.enabled)
    .map((c) => ({ id: c.id, writeTools: (state[c.id]?.writeTools ?? []).filter((t) => c.permittedWriteTools.includes(t)) }))
}
