import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { AgentGrid, permissionLabel } from '../../web/src/components/AgentGrid.js'
import { initialLiveState, type LiveAgent } from '../../web/src/useLiveRun.js'

const agent = { agentId: 'a', label: 'competitor-01', modelId: 'opencode/muse', temperature: 0.7, strategyMd: '', bornRound: 1, parentAgentId: null }
const waiting: LiveAgent = {
  status: 'running', activity: 'bash', tokensIn: 0, tokensOut: 0, costUsd: 0, failure: null, usageReported: false,
  permission: { requestId: 'per_1', permission: 'external_directory', patterns: ['/tmp/*'], since: 10_000 },
}

describe('permission wait on the card', () => {
  test('names the permission, its patterns and how long it has waited', () => {
    expect(permissionLabel(waiting.permission!, 10_000 + 83_000)).toBe('Waiting for permission: external_directory /tmp/* · 1m 23s')
    expect(permissionLabel(waiting.permission!, 10_000 + 4_200)).toBe('Waiting for permission: external_directory /tmp/* · 4s')
    expect(permissionLabel({ ...waiting.permission!, patterns: [] }, 9_000)).toBe('Waiting for permission: external_directory · 0s')
  })

  test('a waiting agent is shown as waiting, not as active work', () => {
    const html = renderToStaticMarkup(createElement(AgentGrid, {
      agents: [agent], live: { ...initialLiveState, agents: { a: waiting } },
    }))
    expect(html).toContain('Waiting for permission: external_directory /tmp/*')
    expect(html).toContain('cell__permission')
  })

  test('an agent with no pending request shows no wait', () => {
    const html = renderToStaticMarkup(createElement(AgentGrid, {
      agents: [agent], live: { ...initialLiveState, agents: { a: { ...waiting, permission: null } } },
    }))
    expect(html).not.toContain('Waiting for permission')
  })
})
