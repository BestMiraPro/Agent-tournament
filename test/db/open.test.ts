import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'

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

  test('preserves an initial goal across a file-backed reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tournament-goal-test-'))
    const dbPath = join(dir, 'goal.sqlite')
    try {
      const first = openDb(dbPath)
      const run = makeRepos(first).runs.create({
        name: 'goal test', initialGoal: 'persist this goal', config: DEFAULT_CONFIG, seedDir: null,
      })
      first.close()

      const second = openDb(dbPath)
      expect(makeRepos(second).runs.get(run.id)!.initialGoal).toBe('persist this goal')
      second.close()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('migrates an old runs table with a nullable initial goal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tournament-migrate-goal-test-'))
    const dbPath = join(dir, 'old.sqlite')
    try {
      const old = new DatabaseSync(dbPath)
      old.exec(`CREATE TABLE runs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
        status TEXT NOT NULL, config_json TEXT NOT NULL, seed_dir TEXT
      )`)
      old.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)')
        .run('old-run', 'old run', Date.now(), 'active', '{}', null)
      old.close()

      const migrated = openDb(dbPath)
      expect(makeRepos(migrated).runs.get('old-run')!.initialGoal).toBeNull()
      migrated.close()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('migrates a runs table that predates initial criteria, without inventing any', async () => {
    // The immediately previous schema: it already has initial_goal, not initial_criteria.
    // A historical run never recorded its creation criteria, so the only honest value is
    // null — a fabricated default would make old runs claim criteria nobody supplied.
    const dir = await mkdtemp(join(tmpdir(), 'agent-tournament-migrate-criteria-test-'))
    const dbPath = join(dir, 'old.sqlite')
    try {
      const old = new DatabaseSync(dbPath)
      old.exec(`CREATE TABLE runs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
        status TEXT NOT NULL, config_json TEXT NOT NULL, seed_dir TEXT, initial_goal TEXT
      )`)
      old.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?)')
        .run('old-run', 'old run', Date.now(), 'active', '{}', null, 'kept goal')
      old.close()

      const migrated = openDb(dbPath)
      const row = makeRepos(migrated).runs.get('old-run')!
      expect(row.initialCriteria).toBeNull()
      expect(row.initialGoal).toBe('kept goal')
      migrated.close()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('preserves multiline initial criteria exactly across a file-backed reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tournament-criteria-test-'))
    const dbPath = join(dir, 'criteria.sqlite')
    const criteria = 'Calmar first\nOmega second\n  indented third'
    try {
      const first = openDb(dbPath)
      const run = makeRepos(first).runs.create({
        name: 'criteria test', initialGoal: 'g', initialCriteria: criteria, config: DEFAULT_CONFIG, seedDir: null,
      })
      first.close()

      const second = openDb(dbPath)
      expect(makeRepos(second).runs.get(run.id)!.initialCriteria).toBe(criteria)
      second.close()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
