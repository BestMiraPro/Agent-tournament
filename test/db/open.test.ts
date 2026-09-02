import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  test('is idempotent when reopened', async () => {
    // A real reopen against a file-backed database: the schema's CREATE TABLE
    // IF NOT EXISTS guards (and migrate()) must tolerate running a second time
    // against a database that already has the tables and data from the first
    // open, not just tolerate running once against a fresh :memory: database.
    const dir = await mkdtemp(join(tmpdir(), 'agent-tournament-open-test-'))
    const dbPath = join(dir, 'reopen.sqlite')
    try {
      const first = openDb(dbPath)
      first.prepare(
        'INSERT INTO runs (id, name, created_at, status, config_json, seed_dir) VALUES (?,?,?,?,?,?)',
      ).run('run-1', 'reopen test run', Date.now(), 'pending', '{}', null)
      first.close()

      let second: ReturnType<typeof openDb> | undefined
      expect(() => {
        second = openDb(dbPath)
      }).not.toThrow()

      const row = second!.prepare('SELECT id, name FROM runs WHERE id = ?').get('run-1') as
        | { id: string; name: string }
        | undefined
      expect(row).toEqual({ id: 'run-1', name: 'reopen test run' })
      second!.close()
    } finally {
      // Best-effort: a lingering file lock here must not mask a real assertion
      // failure from above by throwing in this `finally` block.
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
