import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
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

/**
 * Round-1 strategies taken from the operator's own texts, handed out in order and cycled
 * when the population is larger. With none given the default seeds apply, which are the
 * mock keywords: fine for a mock run, meaningless to a real model.
 */
export function seedStrategyFrom(strategies: readonly string[]): (index: number) => string {
  if (strategies.length === 0) return defaultSeedStrategy
  return (index) => strategies[index % strategies.length]!
}

/** The non-empty `.md` files of `dir`, in name order: one starting strategy per file. */
export async function loadSeedStrategies(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort()
  } catch (e) {
    throw new Error(`seed strategies folder ${dir} cannot be read: ${(e as NodeJS.ErrnoException).code ?? e}`)
  }
  const strategies = (await Promise.all(names.map((n) => readFile(join(dir, n), 'utf8'))))
    .map((text) => text.trim())
    .filter((text) => text !== '')
  if (strategies.length === 0) throw new Error(`no .md strategy files in ${dir}`)
  return strategies
}
