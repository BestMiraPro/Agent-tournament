import type { Db } from './open.js'

// WHY: single-server-per-db is already assumed (registry/budgets/tasks are in-memory —
// a second process can't drive the first's runs), so failing stuck rows can't strand live
// work; containers are left for the creation-time sweep, workspaces preserved by construction.
// Takes the Db handle rather than Repos so repos.ts stays untouched.
export function recoverIncompleteRounds(db: Db): number {
  const result = db
    .prepare("UPDATE rounds SET status = 'failed' WHERE status NOT IN ('complete', 'failed')")
    .run()
  return Number(result.changes ?? 0)
}
