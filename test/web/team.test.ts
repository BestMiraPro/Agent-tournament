import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/core/types.js'
import type { TeamOutput } from '../../web/src/api.js'
import { ChannelList } from '../../web/src/components/ChannelPanel.js'
import { RunSetup, TeamContainerSummary } from '../../web/src/components/RunSetup.js'
import { TeamFileList, TeamFileView } from '../../web/src/components/TeamOutput.js'
import { teamSetupEstimate } from '../../web/src/lib/placement.js'
import { channelHeader, fileContributors, formatBytes, sealLine } from '../../web/src/lib/team.js'
import { initialLiveState, liveReducer, MAX_CLIENT_CHANNEL } from '../../web/src/useLiveRun.js'

const message = (seq: number, roundIdx = 1) => ({
  type: 'channel.message', runId: 'r', roundIdx, seq, author: 'agent-01', agentId: 'A', target: null, postedAt: '2026-11-15T10:00:05.000Z', body: `post ${seq}`,
})

describe('live channel and team score', () => {
  const inRound = liveReducer(initialLiveState, { type: 'round.status', runId: 'r', roundIdx: 1, status: 'preparing' })

  test('entries of the live round are kept once each, in order, and a new round starts empty', () => {
    let s = liveReducer(inRound, message(2))
    s = liveReducer(s, message(1))
    s = liveReducer(s, message(2))
    s = liveReducer(s, message(9, 7))
    expect(s.channel.map((m) => m.seq)).toEqual([1, 2])
    s = liveReducer(s, { type: 'round.status', runId: 'r', roundIdx: 2, status: 'preparing' })
    expect(s.channel).toEqual([])
  })

  test('a browser keeps a bounded tail', () => {
    let s = inRound
    for (let i = 1; i <= MAX_CLIENT_CHANNEL + 5; i++) s = liveReducer(s, message(i))
    expect(s.channel).toHaveLength(MAX_CLIENT_CHANNEL)
    expect(s.channel[0]!.seq).toBe(6)
  })

  test('a judged collaboration round sets the team score; a tournament round leaves it alone', () => {
    let s = liveReducer(inRound, { type: 'round.scored', runId: 'r', roundIdx: 1, scores: [{ agentId: 'A', rank: 1, score: 61 }], team: { score: 61, status: 'ok' } })
    expect(s.teamScore).toEqual({ roundIdx: 1, score: 61, status: 'ok' })
    s = liveReducer(s, { type: 'round.scored', runId: 'r', roundIdx: 2, scores: [] })
    expect(s.teamScore).toEqual({ roundIdx: 1, score: 61, status: 'ok' })
  })
})

describe('team output browser', () => {
  const output: TeamOutput = {
    roundId: 'x', status: 'ok', errorText: null, digest: `sha256:${'a'.repeat(64)}`, sealed: true, hashesComplete: true,
    fileCount: 3, totalBytes: 2048,
    files: [
      { path: 'output/README.md', bytes: 100, sha256: 'h', binary: false, stored: true },
      { path: 'output/model.py', bytes: 1500, sha256: 'h', binary: false, stored: true },
      { path: 'output/plot.png', bytes: 448, sha256: 'h', binary: true, stored: false },
    ],
    contributions: {
      A: { label: 'agent-01', files: ['output/model.py', 'output/README.md'], posts: 3, toolCalls: 9 },
      B: { label: 'agent-02', files: ['output/README.md'], posts: 2, toolCalls: 4 },
    },
    capturedAt: 0,
  }

  test('each file says who wrote it, and the seal is described', () => {
    expect(fileContributors(output).get('output/README.md')).toEqual(['agent-01', 'agent-02'])
    const html = renderToStaticMarkup(createElement(TeamFileList, { output, selected: 'output/README.md', onSelect: () => {} }))
    expect(html).toContain('output/model.py')
    expect(html).toContain('1.5 KiB · agent-01')
    expect(html).toContain('448 B · binary')
    expect(sealLine(output)).toBe('3 files, 2.0 KiB · sealed after every agent stopped · sha256:aaaaaaaaaaaa…')
    expect(sealLine({ ...output, sealed: false })).toContain('not certifiable')
    expect(formatBytes(3 * 1024 ** 2)).toBe('3.0 MiB')
  })

  test('markdown renders, other text stays verbatim, binary is described rather than shown', () => {
    expect(renderToStaticMarkup(createElement(TeamFileView, { file: { ...output.files[0]!, content: '# Built' } }))).toContain('<h')
    expect(renderToStaticMarkup(createElement(TeamFileView, { file: { ...output.files[1]!, content: 'print(1)' } }))).toContain('<pre class="teamoutput__text">print(1)</pre>')
    expect(renderToStaticMarkup(createElement(TeamFileView, { file: { ...output.files[2]!, content: null } }))).toContain('Binary file')
  })

  test('the channel list shows author, target and time', () => {
    expect(channelHeader({ author: 'agent-02', target: 'agent-01', postedAt: '2026-11-15T10:00:05.000Z' })).toBe('agent-02 → @agent-01 · 10:00:05')
    const html = renderToStaticMarkup(createElement(ChannelList, { messages: [{ seq: 1, author: 'agent-01', agentId: 'A', target: null, postedAt: '2026-11-15T10:00:05.000Z', body: 'hello <b>team</b>' }] }))
    expect(html).toContain('agent-01 · 10:00:05')
    expect(html).toContain('hello &lt;b&gt;team&lt;/b&gt;')
    expect(renderToStaticMarkup(createElement(ChannelList, { messages: [] }))).toContain('No posts yet.')
  })
})

describe('run setup for collaboration', () => {
  test('the workflow is chosen in the form, the app default is preselected, and App sends it', () => {
    const html = renderToStaticMarkup(createElement(RunSetup, { busy: false, error: null, onCreate: () => {} }))
    expect(html).toContain('id="setup-workflow"')
    expect(html).toMatch(new RegExp(`<option value="${DEFAULT_CONFIG.workflow}" selected=""`))
    expect(readFileSync('web/src/App.tsx', 'utf8')).toContain('workflow: value.workflow')
  })

  test('a team container is summed per agent with its gateway, and checked like the server checks it', () => {
    const GiB = 1024 ** 3
    const roomy = { totalMemoryBytes: 16 * GiB, usedMemoryBytes: 0, cpus: 16, reservedMemoryBytes: 0, reservedCpus: 0 }
    const reference = { ...roomy, totalMemoryBytes: 5.2 * GiB }
    expect(teamSetupEstimate({ population: 4, memory: '1g', cpus: 1 }, roomy).ceilings)
      .toBe('1 container for 4 agents: 4 × 1g = 4g, plus a 64m gateway = 4.06 GiB memory, 4.25 CPUs')
    expect(teamSetupEstimate({ population: 4, memory: '1g', cpus: 1 }, reference).fit.state).toBe('fits')
    expect(teamSetupEstimate({ population: 5, memory: '1g', cpus: 1 }, reference).fit.state).toBe('does_not_fit')
    const html = renderToStaticMarkup(createElement(TeamContainerSummary, { population: 4, memory: '1g', cpus: 1, capacity: null }))
    expect(html).toContain('one protected container')
    expect(html).toContain('carries over')
    expect(html).toContain('a collaboration run will be refused until it can be')
  })
})

describe('operator post box', () => {
  test('shown only while the round is live', async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { ChannelPanel } = await import('../../web/src/components/ChannelPanel.js')
    const render = (live: boolean) => renderToStaticMarkup(createElement(ChannelPanel, { runId: 'r', roundIdx: 1, live, liveMessages: [] }))
    expect(render(true)).toContain('Message the team')
    expect(render(true)).toContain('Post to the team')
    expect(render(false)).not.toContain('Message the team')
  })
})
