import { DatabaseSync } from 'node:sqlite'
import { SCHEMA } from './schema.js'

export type Db = DatabaseSync

/** `node:sqlite` is built into Node 24 — no native compilation step. */
export function openDb(path: string): Db {
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  return db
}
