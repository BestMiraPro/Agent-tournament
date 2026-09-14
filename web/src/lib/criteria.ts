import type { AppliedCriteria, RunSnapshot } from '../api.js'

/**
 * The criteria draft the editor starts from — taken only from the run being shown.
 *
 * Before round 1 that is the creation criteria saved with the run. After that it is the
 * latest round's recorded criteria, inherited visibly the way the goal is, and never the
 * creation default: a round that asked for generated criteria must not quietly get the
 * default back. Reading only the snapshot is also what stops run A's criteria from seeding
 * run B's editor while app-level round data for B is still loading.
 */
export function criteriaDraftSeed(
  snapshot: Pick<RunSnapshot, 'lastRoundIdx' | 'initialCriteria' | 'lastRoundCriteria'>,
): string {
  if (snapshot.lastRoundIdx === 0) return snapshot.initialCriteria ?? ''
  return snapshot.lastRoundCriteria?.criteriaMd ?? ''
}

/**
 * What the server receives: exactly the visible draft, or null — generate — when it is
 * blank. There is no other source; the old hidden setup value is gone.
 */
export function criteriaForSubmit(draft: string): string | null {
  return draft.trim() === '' ? null : draft
}

export type CriteriaDraftState = 'unsaved-override' | 'applied' | 'next-round'

/**
 * How the draft relates to what is recorded. While a round runs, a draft that differs from
 * its applied criteria is an unsaved override, and must not read as if it had been applied.
 * Between rounds the draft is simply what the next round will receive.
 */
export function criteriaDraftState(
  draft: string,
  applied: AppliedCriteria | null,
  busy: boolean,
): CriteriaDraftState {
  if (!busy) return 'next-round'
  return criteriaForSubmit(draft) === (applied?.criteriaMd ?? null) ? 'applied' : 'unsaved-override'
}
