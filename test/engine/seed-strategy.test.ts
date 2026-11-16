import { describe, expect, test } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSeedStrategy, loadSeedStrategies, seedStrategyFrom } from '../../src/engine/seed-strategy.js'
import { GOOD_KEYWORDS, trueFitness } from '../../src/runtime/mock-provider.js'

describe('defaultSeedStrategy', () => {
  test('gives every agent a non-zero starting fitness', () => {
    // A keyword-free seed scores 0, which leaves reflection nothing to imitate.
    for (let i = 0; i < 12; i++) {
      expect(trueFitness(defaultSeedStrategy(i))).toBeGreaterThan(0)
    }
  })

  test('gives different agents different keywords', () => {
    const seeds = Array.from({ length: GOOD_KEYWORDS.length }, (_, i) => defaultSeedStrategy(i))
    expect(new Set(seeds).size).toBe(GOOD_KEYWORDS.length)
  })

  test('cycles keywords when the population exceeds the keyword count', () => {
    // The variant number keeps rising, so only the keyword repeats.
    const n = GOOD_KEYWORDS.length
    const first = GOOD_KEYWORDS.find((k) => defaultSeedStrategy(0).includes(k))
    expect(first).toBeDefined()
    expect(defaultSeedStrategy(n)).toContain(first!)
  })

  test('is deterministic', () => {
    expect(defaultSeedStrategy(3)).toBe(defaultSeedStrategy(3))
  })

  test('a population of 4 carries at least two distinct keywords', () => {
    // Diversity is what reflection transfers between agents; a population that shares
    // one keyword has nothing to trade and its fitness curve goes flat.
    const seeds = [0, 1, 2, 3].map(defaultSeedStrategy)
    const keywords = GOOD_KEYWORDS.filter((k) => seeds.some((s) => s.includes(k)))
    expect(keywords.length).toBeGreaterThanOrEqual(2)
  })
})

describe('every entry point uses it', () => {
  test('no source file inlines its own keyword-free seed strategy', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const files = [
      'src/cli.ts',
      'src/server/api.ts',
      'src/server/index.ts',
    ]
    for (const f of files) {
      const src = await readFile(join(process.cwd(), f), 'utf8')
      // The old shape: a template literal ending right after the variant number.
      expect(src).not.toMatch(/attempt the goal, variant \$\{[^}]+\}`/)
    }
  })
})

describe('seedStrategyFrom', () => {
  test('hands out the given strategies in order and cycles when the population is larger', () => {
    const seed = seedStrategyFrom(['first', 'second'])
    expect([0, 1, 2, 3].map(seed)).toEqual(['first', 'second', 'first', 'second'])
  })

  test('falls back to the default seeds when none are given', () => {
    expect(seedStrategyFrom([])(3)).toBe(defaultSeedStrategy(3))
  })
})

describe('loadSeedStrategies', () => {
  test('reads the .md files of a folder in name order, trimmed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seeds-'))
    await writeFile(join(dir, '02-skeptic.md'), '\nquestion every claim\n')
    await writeFile(join(dir, '01-tracer.md'), 'read the failed traces first')
    await writeFile(join(dir, 'notes.txt'), 'not a strategy')
    await writeFile(join(dir, '03-empty.md'), '   \n')
    await mkdir(join(dir, 'nested.md'))
    expect(await loadSeedStrategies(dir)).toEqual(['read the failed traces first', 'question every claim'])
  })

  test('refuses a folder with no strategies, naming it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seeds-empty-'))
    await expect(loadSeedStrategies(dir)).rejects.toThrow(`no .md strategy files in ${dir}`)
  })

  test('refuses a folder that does not exist, naming it', async () => {
    const dir = join(tmpdir(), 'seeds-missing-does-not-exist')
    await expect(loadSeedStrategies(dir)).rejects.toThrow(`seed strategies folder ${dir} cannot be read`)
  })
})
