import { describe, expect, test } from 'vitest'
import { openDb } from '../../src/db/open.js'

describe('openDb', () => {
  test('creates all tables in memory', () => {
    const db = openDb(':memory:')
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const names = rows.map((r) => r.name)
    for (const t of ['agents', 'events', 'genomes', 'rounds', 'runs', 'scores', 'submissions']) {
      expect(names).toContain(t)
    }
    db.close()
  })

  test('enforces foreign keys', () => {
    const db = openDb(':memory:')
    expect(() =>
      db.prepare('INSERT INTO rounds (id, run_id, idx, goal_md, criteria_source, judge_mode, status) VALUES (?,?,?,?,?,?,?)')
        .run('r1', 'missing-run', 1, 'goal', 'generated', 'single_call', 'pending'),
    ).toThrow()
    db.close()
  })

  test('is idempotent when reopened', () => {
    const db = openDb(':memory:')
    expect(() => db.exec('SELECT 1')).not.toThrow()
    db.close()
  })
})
