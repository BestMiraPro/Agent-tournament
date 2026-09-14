import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { startRound, type RunSnapshot } from '../../web/src/api.js'
import { RoundControls } from '../../web/src/components/RoundControls.js'
import { criteriaDraftSeed, criteriaDraftState, criteriaForSubmit } from '../../web/src/lib/criteria.js'

/**
 * The create -> dashboard -> start flow for judging criteria.
 *
 * This repository has no DOM test environment (vitest runs in node, and the only render
 * tooling is react-dom/server), so clicks and typing cannot be simulated. What IS
 * exercised: the real RoundControls markup rendered from a snapshot, the real `startRound`
 * client building its request body, and the decisions App makes to connect the two —
 * plus a guard that App actually routes through them rather than a parallel path.
 */
const CRITERIA = 'Calmar first\nOmega second'

const snapshotFor = (over: Partial<RunSnapshot>): RunSnapshot => ({
  runId: 'A', name: 'A', lastRoundIdx: 0, goalMd: 'g', agents: [], scores: [],
  busy: false, lastError: null, sandbox: 'mock', roster: [], capacity: null, warnings: [],
  initialCriteria: null, lastRoundCriteria: null,
  ...over,
})

const render = (snapshot: RunSnapshot, opts: { busy?: boolean; draft?: string } = {}) =>
  renderToStaticMarkup(createElement(RoundControls, {
    goal: 'g',
    busy: opts.busy ?? false,
    roundIdx: snapshot.lastRoundIdx,
    onRun: () => {},
    criteria: opts.draft ?? criteriaDraftSeed(snapshot),
    appliedCriteria: snapshot.lastRoundCriteria,
  }))

const decode = (html: string) =>
  html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')

/** The rendered content of the criteria textarea — what the operator actually sees. */
function criteriaTextarea(markup: string): string {
  const m = /<textarea[^>]*id="criteria"[^>]*>([\s\S]*?)<\/textarea>/.exec(markup)
  if (!m) throw new Error('criteria textarea was not rendered')
  // React prefixes a textarea's content with a newline when the value itself starts with one.
  return decode(m[1]!)
}

/** The JSON body the real client sends when a round starts. */
async function startBody(criteriaMd: string | null): Promise<{ goalMd: string; criteriaMd: string | null }> {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response('{"started":true}', { status: 202, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  await startRound('A', 'g', criteriaMd)
  return JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))
}

afterEach(() => vi.unstubAllGlobals())

describe('criteria before round 1', () => {
  test('opening a run shows exactly the criteria it was created with', () => {
    expect(criteriaTextarea(render(snapshotFor({ initialCriteria: CRITERIA })))).toBe(CRITERIA)
  })

  test('starting without editing submits exactly that visible text', async () => {
    const seed = criteriaDraftSeed(snapshotFor({ initialCriteria: CRITERIA }))
    expect((await startBody(criteriaForSubmit(seed))).criteriaMd).toBe(CRITERIA)
  })

  test('clearing the draft requests generation, with no hidden fallback', async () => {
    expect(criteriaForSubmit('')).toBeNull()
    expect(criteriaForSubmit('  \n\t ')).toBeNull()
    expect((await startBody(criteriaForSubmit(''))).criteriaMd).toBeNull()
  })

  test('a non-blank draft is sent as typed, not trimmed', () => {
    expect(criteriaForSubmit('  keep\nthe spacing  ')).toBe('  keep\nthe spacing  ')
  })

  test('run B, created without criteria, shows and sends none of run A\'s', async () => {
    const b = snapshotFor({ runId: 'B', name: 'B', initialCriteria: null })
    expect(criteriaTextarea(render(b))).toBe('')
    expect((await startBody(criteriaForSubmit(criteriaDraftSeed(b)))).criteriaMd).toBeNull()
  })
})

describe('criteria after rounds have started', () => {
  test('the draft inherits this run\'s applied criteria, never the creation default', () => {
    const s = snapshotFor({
      lastRoundIdx: 1,
      initialCriteria: 'creation text',
      lastRoundCriteria: { roundIdx: 1, criteriaMd: 'generated text', source: 'generated', status: 'complete' },
    })
    expect(criteriaDraftSeed(s)).toBe('generated text')
  })

  test('a round still waiting for generated criteria does not fall back to the creation default', () => {
    const s = snapshotFor({
      lastRoundIdx: 1,
      initialCriteria: 'creation text',
      lastRoundCriteria: { roundIdx: 1, criteriaMd: null, source: 'generated', status: 'running' },
    })
    expect(criteriaDraftSeed(s)).toBe('')
  })

  test('applied criteria are shown apart from the draft', () => {
    const s = snapshotFor({
      lastRoundIdx: 1,
      lastRoundCriteria: { roundIdx: 1, criteriaMd: CRITERIA, source: 'user', status: 'running' },
    })
    const markup = decode(render(s, { busy: true }))
    expect(markup).toContain('Applied to round 1')
    expect(markup).not.toContain('Unsaved override')
  })

  test('a draft that differs from what the round applied is labelled as unsaved', () => {
    const s = snapshotFor({
      lastRoundIdx: 1,
      lastRoundCriteria: { roundIdx: 1, criteriaMd: CRITERIA, source: 'user', status: 'running' },
    })
    expect(decode(render(s, { busy: true, draft: 'a different draft' }))).toContain('Unsaved override')
  })

  test('criteria that have not been generated yet say so rather than showing blank', () => {
    const s = snapshotFor({
      lastRoundIdx: 1,
      lastRoundCriteria: { roundIdx: 1, criteriaMd: null, source: 'generated', status: 'running' },
    })
    expect(decode(render(s, { busy: true }))).toContain('Generated when judging starts')
  })

  test('draft state distinguishes an unsaved override, applied text and the next round', () => {
    const applied = { roundIdx: 1, criteriaMd: 'A', source: 'user' as const, status: 'running' }
    expect(criteriaDraftState('B', applied, true)).toBe('unsaved-override')
    expect(criteriaDraftState('A', applied, true)).toBe('applied')
    expect(criteriaDraftState('anything', applied, false)).toBe('next-round')
  })
})

describe('App wiring', () => {
  /**
   * Guard, not ceremony: the helpers above only matter if App actually uses them. The
   * previous design kept setup criteria in a hidden `pendingCriteria` variable and sent
   * `criteriaMd ?? first` — text the operator could not see.
   */
  test('App seeds the editor from the snapshot and no longer holds hidden criteria', () => {
    const app = readFileSync('web/src/App.tsx', 'utf8')
    expect(app).not.toMatch(/pendingCriteria/)
    expect(app).not.toMatch(/criteriaMd \?\? first/)
    expect(app).toMatch(/criteriaDraftSeed\(snapshot\)/)
    expect(app).toMatch(/appliedCriteria=\{snapshot\.lastRoundCriteria\}/)
  })
})
