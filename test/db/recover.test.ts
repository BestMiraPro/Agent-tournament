import { describe, expect, test } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { recoverIncompleteRounds } from '../../src/db/recover.js'
import { DEFAULT_CONFIG, type RoundStatus } from '../../src/core/types.js'

const ALL_STATUSES: RoundStatus[] = [
  'pending', 'preparing', 'running', 'collecting',
  'judging', 'evolving', 'reflecting', 'complete', 'failed',
]

const setup = () => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const run = repos.runs.create({ name: 'test', config: DEFAULT_CONFIG, seedDir: null })
  return { db, repos, run }
}

describe('recoverIncompleteRounds', () => {
  test('flips only non-terminal rounds to failed and returns the count', () => {
    const { db, repos, run } = setup()
    const seeded = ALL_STATUSES.map((status, i) => {
      const round = repos.rounds.create({ runId: run.id, idx: i + 1, goalMd: 'goal' })
      if (status !== 'pending') repos.rounds.setStatus(round.id, status)
      return { id: round.id, status }
    })
    expect(recoverIncompleteRounds(db)).toBe(7)
    for (const { id, status } of seeded) {
      const got = repos.rounds.get(id)?.status
      if (status === 'complete' || status === 'failed') expect(got).toBe(status)
      else expect(got).toBe('failed')
    }
  })

  test('empty db recovers 0', () => {
    const { db } = setup()
    expect(recoverIncompleteRounds(db)).toBe(0)
  })
})
