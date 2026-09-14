import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { SnapshotAgent } from '../../web/src/api.js'
import { AgentDrawer } from '../../web/src/components/AgentDrawer.js'
import { AgentGrid } from '../../web/src/components/AgentGrid.js'
import { initialLiveState, type LiveAgent, type LiveState } from '../../web/src/useLiveRun.js'

/**
 * The failed-card and drawer presentation, rendered from the real components. The
 * fixture is the September 13 incident: an agent that failed in under six seconds with an
 * OpenCode 500, whose zero score still earned the rank-1 winner badge.
 */
const agent: SnapshotAgent = {
  agentId: 'a', label: 'competitor-01', modelId: 'wandb/deepseek-ai/DeepSeek-V4-Pro-0813',
  temperature: 0.7, strategyMd: '', bornRound: 1, parentAgentId: null,
}

const FAILURE = {
  message: 'OpenCode returned HTTP 500 UnknownError (ref err_0672e772)',
  httpStatus: 500, code: 'UnknownError', ref: 'err_0672e772',
}

const liveAgent = (over: Partial<LiveAgent>): LiveAgent => ({
  status: 'pending', activity: '', tokensIn: 0, tokensOut: 0, costUsd: 0,
  failure: null, usageReported: false,
  ...over,
})

const grid = (live: LiveState) => renderToStaticMarkup(createElement(AgentGrid, { agents: [agent], live }))

describe('AgentGrid failure presentation', () => {
  test('a failed agent shows its failure at once, and no winner badge for a zero-score rank 1', () => {
    const markup = grid({
      ...initialLiveState,
      scores: [{ agentId: 'a', rank: 1, score: 0, failed: true }],
      agents: { a: liveAgent({ status: 'failed', failure: FAILURE }) },
    })
    expect(markup).toContain('HTTP 500 UnknownError')
    expect(markup).not.toContain('data-rank="1"')
    expect(markup).toContain('#1')
  })

  test('a persisted failed score keeps the badge off after a reload, with no live state at all', () => {
    const markup = grid({ ...initialLiveState, scores: [{ agentId: 'a', rank: 1, score: 0, failed: true }] })
    expect(markup).not.toContain('data-rank="1"')
  })

  test('a genuine rank 1 still gets the winner badge', () => {
    const markup = grid({
      ...initialLiveState,
      scores: [{ agentId: 'a', rank: 1, score: 88, failed: false }],
      agents: { a: liveAgent({ status: 'done', usageReported: true, tokensIn: 10, tokensOut: 20 }) },
    })
    expect(markup).toContain('data-rank="1"')
  })

  test('terminal failure without usage says "Usage unavailable", never "0 tok"', () => {
    const markup = grid({ ...initialLiveState, agents: { a: liveAgent({ status: 'failed', failure: FAILURE }) } })
    expect(markup).toContain('Usage unavailable')
    expect(markup).not.toContain('0 tok')
  })

  test('a working agent with no usage yet says "Usage pending"', () => {
    const markup = grid({ ...initialLiveState, agents: { a: liveAgent({ status: 'running' }) } })
    expect(markup).toContain('Usage pending')
    expect(markup).not.toContain('0 tok')
  })

  test('reported usage is shown as a count, including a real zero', () => {
    expect(grid({ ...initialLiveState, agents: { a: liveAgent({ status: 'done', usageReported: true, tokensIn: 10, tokensOut: 20 }) } }))
      .toContain('30 tok')
    expect(grid({ ...initialLiveState, agents: { a: liveAgent({ status: 'done', usageReported: true }) } }))
      .toContain('0 tok')
  })
})

describe('AgentDrawer live failure', () => {
  test('an open drawer shows the current failure details before its persisted detail loads', () => {
    const markup = renderToStaticMarkup(createElement(AgentDrawer, {
      runId: 'r', agentId: 'a', onClose: () => {},
      live: liveAgent({ status: 'failed', failure: FAILURE }),
    }))
    expect(markup).toContain('OpenCode returned HTTP 500 UnknownError')
    expect(markup).toContain('err_0672e772')
    expect(markup).toContain('HTTP 500')
  })

  test('no live failure section for an agent that has not failed', () => {
    const markup = renderToStaticMarkup(createElement(AgentDrawer, {
      runId: 'r', agentId: 'a', onClose: () => {}, live: liveAgent({ status: 'running' }),
    }))
    expect(markup).not.toContain('Current round failure')
  })
})
