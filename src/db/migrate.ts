import type { Db } from './open.js'

/**
 * Additive column migrations for databases created before a column existed.
 * `CREATE TABLE IF NOT EXISTS` does not alter an existing table, so new columns
 * must be added explicitly or older run databases fail to open.
 */
const ADDITIONS: { table: string; column: string; ddl: string }[] = [
  { table: 'runs', column: 'initial_goal', ddl: 'TEXT' },
  // Nullable with no default: runs created before this column never recorded creation
  // criteria, and a fabricated value would make them claim criteria nobody supplied.
  { table: 'runs', column: 'initial_criteria', ddl: 'TEXT' },
  { table: 'submissions', column: 'tokens_cache_read', ddl: 'INTEGER DEFAULT 0' },
  { table: 'submissions', column: 'tokens_cache_write', ddl: 'INTEGER DEFAULT 0' },
  // Nullable with no default: older rows stored 0 both for a lost response and for a
  // genuinely free call, so no value can be recovered for them.
  { table: 'submissions', column: 'usage_known', ddl: 'INTEGER' },
]

export function migrate(db: Db): void {
  for (const a of ADDITIONS) {
    const cols = db.prepare(`PRAGMA table_info(${a.table})`).all() as { name: string }[]
    if (cols.length === 0) continue
    if (cols.some((c) => c.name === a.column)) continue
    db.exec(`ALTER TABLE ${a.table} ADD COLUMN ${a.column} ${a.ddl}`)
  }
}
