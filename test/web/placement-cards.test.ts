import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { Placement } from '../../web/src/api.js'
import { AgentGrid } from '../../web/src/components/AgentGrid.js'
import { initialLiveState } from '../../web/src/useLiveRun.js'

const agent = (agentId: string, label: string) => ({
  agentId, label, modelId: 'w/m', temperature: 0.7, strategyMd: '', bornRound: 1, parentAgentId: null,
})
const agents = [agent('a1', 'c-01'), agent('a2', 'c-02'), agent('a3', 'c-03'), agent('a4', 'c-04')]
const render = (placement: Placement[] | null) =>
  renderToStaticMarkup(createElement(AgentGrid, { agents, live: initialLiveState, placement }))

describe('agent card placement', () => {
  test('each card names its container and whether its agents share it', () => {
    const html = render([
      { shardIndex: 0, agentIds: ['a1', 'a3', 'a4'], occupancy: 'shared' },
      { shardIndex: 1, agentIds: ['a2'], occupancy: 'single' },
    ])
    expect(html).toContain('Container 0 · shared with 2 other agents')
    expect(html).toContain('Container 1 · own container')
  })

  test('one co-tenant reads in the singular', () => {
    expect(render([{ shardIndex: 0, agentIds: ['a1', 'a2'], occupancy: 'shared' }])).toContain('Container 0 · shared with 1 other agent<')
  })

  test('without a live plan the cards claim no placement', () => {
    expect(render(null)).not.toContain('Container ')
  })
})
