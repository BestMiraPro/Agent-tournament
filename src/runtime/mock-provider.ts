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

/**
 * FNV-1a over the whole prompt. Used to derive a per-call RNG seed.
 *
 * Keying the RNG on prompt *length* (as this once did) made the reflection coin
 * flip effectively population-wide: every agent in a round produces a prompt of
 * near-identical length, so they all drew the same value. Worse, an agent whose
 * strategy did not change re-derived the identical seed next round and drew the
 * same value forever — a permanent deadlock. Hashing the full content gives each
 * agent an independent draw while staying fully deterministic.
 */
function hashPrompt(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
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
      case 'review':
        return JSON.stringify({
          reviews: [...req.prompt.matchAll(/<attempt ref="([^"]+)"/g)].map((m) => ({
            ref: m[1]!,
            safety: { status: 'no_issue_observed', findings: [], limitations: [] },
          })),
        })
    }
  }

  describe(): string {
    return 'mock'
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
        criteria: [{ criterion: 'overall quality', assessment: `Ranked ${i + 1} on demonstrated quality.`, evidence_ids: [] }],
        limitations: [],
        safety: { status: 'no_issue_observed', findings: [], limitations: [] },
      })),
      meta_digest: 'Winners verified their work and stayed concise.',
    })
  }

  /** Imitates one keyword found in top strategies but absent from its own. */
  private reflect(prompt: string): string {
    const rng = makeRng((this.seed ^ hashPrompt(prompt)) >>> 0)
    // The whole block between the two markers, not just its first line. Crossover merges
    // parents by splitting on lines, so a recombined strategy is multi-line by
    // construction — and a `.` capture stopped at the first newline, so the mock returned
    // only that line and threw the recombination away on the very next round. `YOUR NOTES:`
    // is a safe delimiter because escapeMarkers neutralises markers inside agent text.
    // The single-line form is the fallback, so a differently shaped prompt still works.
    const own =
      /YOUR STRATEGY: ([\s\S]*?)\nYOUR NOTES:/.exec(prompt)?.[1] ??
      /YOUR STRATEGY: (.*)/.exec(prompt)?.[1] ??
      ''

    // Only the `TOP STRATEGY:` lines themselves may donate keywords. Splitting on
    // the marker instead swallowed the entire prompt tail — including the judge's
    // meta-digest ("...stayed concise") — which handed every agent a free keyword
    // regardless of what the leaders actually wrote. That leak let fitness climb
    // even with selection switched off entirely.
    const topBlock = [...prompt.matchAll(/^TOP STRATEGY: (.*)$/gm)]
      .map((m) => m[1] ?? '')
      .join(' ')

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
