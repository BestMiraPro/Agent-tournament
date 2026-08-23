import type { DatabaseSync } from 'node:sqlite'
import { SCHEMA } from './schema.js'

export type Db = DatabaseSync

/**
 * `node:sqlite` is built into Node 24 — no native compilation step.
 *
 * Deliberately NOT `import { DatabaseSync } from 'node:sqlite'`. On this machine's
 * toolchain (Vite 5.4.21 / Vitest 2.1.9 on Windows), a static import of a "node:"-only
 * builtin (one with no non-prefixed alias, e.g. `node:sqlite`, `node:test`) is mis-resolved:
 * Vite's plugin container receives the specifier already stripped of its `node:` prefix
 * (confirmed via `DEBUG=vite:resolve`, which logged `sqlite -> null`), so it then tries to
 * load a nonexistent bare module `sqlite` and throws `Failed to load url sqlite (resolved
 * id: sqlite). Does the file exist?`. A plain `node --eval` of the same static import works
 * fine, isolating the bug to the SSR module resolution layer, not Node itself.
 *
 * `process.getBuiltinModule` (Node 22.3+, available in Node 24) is the documented escape
 * hatch for exactly this: a plain runtime call the bundler/loader can't rewrite, so the
 * `node:` prefix survives. It is fully typed by @types/node (`BuiltInModule['node:sqlite']`).
 */
export function openDb(path: string): Db {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  return db
}
