import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { ConnectorInfo, ConnectorList } from '../../web/src/api.js'
import { ConnectorCard, ImportList, ToolTable } from '../../web/src/components/Connectors.js'
import { ConnectorPicker } from '../../web/src/components/RunSetup.js'
import { pickerChoices, runConnectorsFrom, togglePolicy, toolRowsFor } from '../../web/src/lib/connectors.js'

const slack: ConnectorInfo = {
  id: 'slack', title: 'Slack', kind: 'slack', builtin: false, origin: { type: 'preset' }, transport: { type: 'slack' },
  auth: { type: 'token', source: 'manual' }, secretsSet: ['token'], connected: true, locked: true,
  readAllowlist: ['search_messages'], policy: { disabledTools: [], writeTools: [] }, toolsCheckedAt: 1,
  tools: [
    { name: 'search_messages', description: 'Search', readOnlyHint: true, classification: 'read' },
    { name: 'send_message', description: 'Send', readOnlyHint: false, classification: 'locked' },
  ],
}
const github: ConnectorInfo = {
  ...slack, id: 'github', title: 'GitHub', kind: 'github', locked: false, readAllowlist: null, transport: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headerNames: [], secretHeaderNames: [] },
  policy: { disabledTools: [], writeTools: ['create_issue'] },
  tools: [
    { name: 'search_code', description: '', readOnlyHint: true, classification: 'read' },
    { name: 'create_issue', description: '', readOnlyHint: false, classification: 'write' },
    { name: 'merge_pull_request', description: '', readOnlyHint: false, classification: 'write' },
  ],
}

describe('connector tool rows', () => {
  test('Slack\'s write tools are shown locked and cannot be switched on', () => {
    const rows = toolRowsFor(slack)
    expect(rows.find((r) => r.name === 'send_message')).toMatchObject({ on: false, editable: false })
    expect(rows.find((r) => r.name === 'send_message')!.note).toMatch(/locked/)
    const locked = rows.find((r) => r.name === 'send_message')!
    expect(togglePolicy(slack.policy, locked)).toBe(slack.policy)
    const html = renderToStaticMarkup(createElement(ToolTable, { rows, busy: false, onToggle: () => {} }))
    expect(html).toMatch(/<tr class="connector-tools__locked"><td><code>send_message<\/code><\/td><td><label><input type="checkbox" disabled=""/)
  })

  test('read tools switch off, write tools are permitted, off by default', () => {
    const rows = toolRowsFor(github)
    expect(rows.map((r) => [r.name, r.on])).toEqual([['search_code', true], ['create_issue', true], ['merge_pull_request', false]])
    expect(togglePolicy(github.policy, rows[0]!)).toEqual({ disabledTools: ['search_code'], writeTools: ['create_issue'] })
    expect(togglePolicy(github.policy, rows[2]!)).toEqual({ disabledTools: [], writeTools: ['create_issue', 'merge_pull_request'] })
  })

  test('a connector card never shows credential values, only which are stored', () => {
    const html = renderToStaticMarkup(createElement(ConnectorCard, { connector: slack, busy: false, onChange: () => {}, onError: () => {} }))
    expect(html).toContain('credentials stored: token')
    expect(html).toContain('read-only, locked')
    expect(html).toContain('type="password"')
  })

  test('the import list says when a server is already imported', () => {
    const html = renderToStaticMarkup(createElement(ImportList, {
      busy: false, onImport: () => {},
      servers: [{ key: 'k', name: 'context7', source: 'user', from: 'user — .claude.json', suggestedId: 'context7', imported: false, transport: { type: 'http', url: 'https://mcp.context7.com/mcp', headers: {} } }],
    }))
    expect(html).toContain('Import as context7')
  })
})

describe('the run setup connector picker', () => {
  const list: ConnectorList = { store: true, connectors: [slack, github], builtins: [{ id: 'web', title: 'Web search', description: '', builtin: true, readOnly: true }] }

  test('offers write opt-ins only where the connector permits them, and only those reach the spec', () => {
    const choices = pickerChoices(list)
    expect(choices.map((c) => [c.id, c.permittedWriteTools])).toEqual([['web', []], ['slack', []], ['github', ['create_issue']]])
    const state = { github: { enabled: true, writeTools: ['create_issue', 'merge_pull_request'] }, slack: { enabled: true, writeTools: ['send_message'] }, web: { enabled: false, writeTools: [] } }
    expect(runConnectorsFrom(state, choices)).toEqual([{ id: 'slack', writeTools: [] }, { id: 'github', writeTools: ['create_issue'] }])
    const html = renderToStaticMarkup(createElement(ConnectorPicker, { choices, state, disabled: false, onChange: () => {} }))
    expect(html).toContain('allow write tool <code>create_issue</code> in this run')
    expect(html).not.toContain('send_message')
    expect(html).toContain('Slack <code>slack</code> — read-only')
  })

  test('App sends the picked connectors with the run', () => {
    expect(readFileSync('web/src/App.tsx', 'utf8')).toContain('...(value.connectors.length > 0 ? { connectors: value.connectors } : {})')
  })
})
