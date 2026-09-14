import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { ActivityTimeline } from '../../web/src/components/ActivityTimeline.js'
import { AgentDrawer } from '../../web/src/components/AgentDrawer.js'
import { AgentGrid } from '../../web/src/components/AgentGrid.js'
import { evidenceAgeLabel } from '../../web/src/lib/activity.js'
import { initialLiveState, type LiveAgent } from '../../web/src/useLiveRun.js'

const agent = { agentId: 'a', label: 'competitor-01', modelId: 'opencode/muse', temperature: 0.7, strategyMd: '', bornRound: 1, parentAgentId: null }
const item = (over: Record<string, unknown> = {}) => ({
  id: 'call_1', runId: 'r', roundIdx: 1, agentId: 'a', sessionId: 'ses', observedAt: 1_000,
  kind: 'tool' as const, status: 'running' as const, summary: 'bash: node backtest.mjs', revision: 1, ...over,
})
const live = (over: Partial<LiveAgent> = {}): LiveAgent => ({
  status: 'running', activity: 'bash: node backtest.mjs', tokensIn: 0, tokensOut: 0, costUsd: 0,
  failure: null, usageReported: false, permission: null, items: [item()], lastObservedAt: Date.now(), ...over,
})

describe('evidence age', () => {
  test('says how old the latest observed event is, and names silence as telemetry', () => {
    expect(evidenceAgeLabel(undefined, 10_000, 'running')).toBe('')
    expect(evidenceAgeLabel(1_000, 13_000, 'running')).toBe('12s ago')
    expect(evidenceAgeLabel(1_000, 46_000, 'running')).toBe('No activity received for 45s')
    expect(evidenceAgeLabel(1_000, 125_000, 'running')).toBe('No activity received for 2m 4s')
    // A finished agent is not "silent"; its last event is simply in the past.
    expect(evidenceAgeLabel(1_000, 46_000, 'done')).toBe('45s ago')
  })

  test('the card shows the current summary and the silence warning', () => {
    const html = renderToStaticMarkup(createElement(AgentGrid, {
      agents: [agent], live: { ...initialLiveState, agents: { a: live({ lastObservedAt: Date.now() - 60_000 }) } },
    }))
    expect(html).toContain('bash: node backtest.mjs')
    expect(html).toContain('No activity received for')
  })
})

describe('ActivityTimeline', () => {
  test('renders public activity as text, with bounded expandable output', () => {
    const html = renderToStaticMarkup(createElement(ActivityTimeline, {
      items: [
        item({ id: 't1', kind: 'text', status: undefined, summary: '<img src=x onerror=alert(1)>' }),
        item({ id: 'call_1', status: 'completed', output: 'sharpe=1.41', truncated: true }),
        item({ id: 'per_1', kind: 'permission', status: 'waiting', summary: 'Permission external_directory /tmp/*' }),
        item({ id: 'error:ses', kind: 'error', status: 'error', summary: 'APIError: rate limited' }),
      ],
      truncated: true,
      unavailable: false,
    }))
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('<details')
    expect(html).toContain('sharpe=1.41')
    expect(html).toContain('Output truncated')
    expect(html).toContain('Waiting for permission')
    expect(html).toContain('APIError: rate limited')
    expect(html).toContain('Older activity was dropped')
    // A log that does not announce every streamed token.
    expect(html).toContain('role="log"')
    expect(html).toContain('aria-live="off"')
  })

  test('says so when nothing has arrived, and when history was lost to a restart', () => {
    expect(renderToStaticMarkup(createElement(ActivityTimeline, { items: [], truncated: false, unavailable: false })))
      .toContain('No live activity received yet.')
    expect(renderToStaticMarkup(createElement(ActivityTimeline, { items: [], truncated: false, unavailable: true })))
      .toContain('Live activity from before the server restarted is not available')
  })

  test('the drawer shows the live timeline for the selected agent', () => {
    const html = renderToStaticMarkup(createElement(AgentDrawer, {
      runId: 'r', agentId: 'a', onClose: () => {}, live: live(),
    }))
    expect(html).toContain('Live activity')
    expect(html).toContain('bash: node backtest.mjs')
  })

  test('the app wires stream health and restart unavailability into the views', () => {
    const app = readFileSync('web/src/App.tsx', 'utf8')
    expect(app).toMatch(/activityStreamWarning\(live\.streams\)/)
    expect(app).toMatch(/activityUnavailable=\{/)
  })
})
