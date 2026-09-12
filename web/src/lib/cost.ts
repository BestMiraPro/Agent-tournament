/**
 * What every cost figure in this UI actually covers, and how to say so.
 *
 * Reported cost is the sum of SUBMISSION costs — the agents' own model calls. It excludes
 * every orchestration call: judging, reflection, criteria generation and recombination.
 * Those run through `Provider.complete`, which returns text and no usage envelope, so the
 * engine never sees what they cost. The same is true of the budget caps: `budget.record`
 * is called once per agent inside the run loop and nowhere else, so a run-level USD cap
 * does not count orchestration either.
 *
 * With a 20-agent round that is one judge call plus up to 20 reflect calls unaccounted
 * for, which can be a large share of real spend — so labelling this "total" would be
 * wrong by a wide and variable margin. It is labelled for what it is until the provider
 * contract can carry usage back; see I12 in the review handoff.
 *
 * One source for the wording so the views cannot drift apart on what they are claiming.
 */
export const WORKER_COST_LABEL = 'worker cost'

/** Title-case form, for table headers and definition lists. */
export const WORKER_COST_HEADING = 'Worker cost'

export const WORKER_COST_TITLE =
  'Agent model calls only. Judging, reflection, criteria generation and recombination are ' +
  'not included — the provider returns no usage for them — so real spend is higher than this.'

export function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`
}
