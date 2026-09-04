import { GOOD_KEYWORDS } from '../runtime/mock-provider.js'

/**
 * The strategy each agent starts round 1 with.
 *
 * Every agent gets a DIFFERENT keyword. That is the whole point: reflection improves an
 * agent by imitating what it sees in the leaders' strategies, so if every agent starts
 * with the same (or no) keywords there is nothing to transfer and fitness cannot climb.
 *
 * This lived inline at four separate call sites — the CLI, both server entry points, and
 * the test helper. Phase 1 fixed the CLI and the helper; the servers kept the old
 * keyword-free text, so the dashboard showed a population whose mean fitness was exactly
 * flat across every round while the CLI climbed 14.57 -> 66.94 on the same engine.
 *
 * It is a single exported function now so that divergence cannot recur.
 */
export function defaultSeedStrategy(index: number): string {
  const keyword = GOOD_KEYWORDS[index % GOOD_KEYWORDS.length]
  return `attempt the goal, variant ${index}, focus on ${keyword}`
}
