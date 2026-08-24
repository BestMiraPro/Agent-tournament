import type { Db } from './open.js'

/**
 * Additive column migrations for databases created before a column existed.
 * `CREATE TABLE IF NOT EXISTS` does not alter an existing table, so new columns
 * must be added explicitly or older run databases fail to open.
 */
const ADDITIONS: { table: string; column: string; ddl: string }[] = [
  { table: 'submissions', column: 'tokens_cache_read', ddl: 'INTEGER DEFAULT 0' },
  { table: 'submissions', column: 'tokens_cache_write', ddl: 'INTEGER DEFAULT 0' },
]

export function migrate(db: Db): void {
  for (const a of ADDITIONS) {
    const cols = db.prepare(`PRAGMA table_info(${a.table})`).all() as { name: string }[]
    if (cols.length === 0) continue
    if (cols.some((c) => c.name === a.column)) continue
    db.exec(`ALTER TABLE ${a.table} ADD COLUMN ${a.column} ${a.ddl}`)
  }
}
