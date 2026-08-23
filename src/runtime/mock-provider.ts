import { makeRng } from '../core/rng.js'
import type { CompleteRequest, Provider } from './provider.js'

/** Hidden fitness signal. Strategies containing more of these score higher. */
export const GOOD_KEYWORDS = [
  'verify', 'test', 'iterate', 'concise', 'structure', 'evidence', 'example',
] as const

export function trueFitness(strategy: string): number {
  const s = strategy.toLowerCase()
  const hits = GOOD_KEYWORDS.filter((k) => s.includes(k)).length
  return (hits / GOOD_KEYWORDS.length) * 100
}

export class MockProvider implements Provider {
  constructor(private seed: number) {}

  async complete(req: CompleteRequest): Promise<string> {
    switch (req.purpose) {
      case 'criteria':
        return JSON.stringify({
          criteria: [
            { name: 'correctness', weight: 0.4 },
            { name: 'clarity', weight: 0.3 },
            { name: 'completeness', weight: 0.3 },
          ],
        })
      case 'judge':
        return this.judge(req.prompt)
      case 'reflect':
        return this.reflect(req.prompt)
    }
  }

  /** Reads FITNESS=<n> out of each submission block and ranks by it. */
  private judge(prompt: string): string {
    const rng = makeRng(this.seed)
    const re = /<submission ref="([^"]+)">([\s\S]*?)<\/submission>/g
    const items: { ref: string; fitness: number }[] = []
    for (const m of prompt.matchAll(re)) {
      const fitness = Number(/FITNESS=([\d.]+)/.exec(m[2] ?? '')?.[1] ?? '0')
      // Small deterministic jitter models real judge imprecision.
      items.push({ ref: m[1]!, fitness: fitness + rng.next() * 0.5 })
    }
    items.sort((a, b) => b.fitness - a.fitness)
    return JSON.stringify({
      rankings: items.map((it, i) => ({
        ref: it.ref,
        rank: i + 1,
        score: Math.round(Math.min(100, it.fitness) * 100) / 100,
        rationale: `Ranked ${i + 1} on demonstrated quality.`,
      })),
      meta_digest: 'Winners verified their work and stayed concise.',
    })
  }

  /** Imitates one keyword found in top strategies but absent from its own. */
  private reflect(prompt: string): string {
    const rng = makeRng(this.seed + prompt.length)
    const own = /YOUR STRATEGY: (.*)/.exec(prompt)?.[1] ?? ''
    const topBlock = prompt.split('TOP STRATEGY:').slice(1).join(' ')

    const missing = GOOD_KEYWORDS.filter(
      (k) => topBlock.toLowerCase().includes(k) && !own.toLowerCase().includes(k),
    )

    let next = own
    if (missing.length > 0 && rng.next() < 0.8) {
      next = `${own} ${rng.pick(missing)}`.trim()
    } else if (rng.next() < 0.2) {
      next = `${own} refine`.trim()
    }

    return JSON.stringify({
      strategy_md: next || 'attempt the goal',
      notes_md: 'Adjusted after reviewing the leaders.',
    })
  }
}
