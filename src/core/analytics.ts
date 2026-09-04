/**
 * Word-set tokenization shared by strategyDiversity and the selection
 * diversityFloor: lowercase + whitespace-split; empty/whitespace-only
 * strategies become empty sets (the '' split artifact is dropped by filter).
 */
export function strategyWordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter(Boolean))
}

/**
 * Word-set Jaccard distance: 0 = identical, 1 = disjoint. Two empty sets are
 * identical (similarity 1), not 0/0.
 */
export function jaccardDistance(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const word of a) if (b.has(word)) inter++
  // |A ∪ B| = |A| + |B| − |A ∩ B|; non-zero here because at least one set is non-empty.
  return 1 - inter / (a.size + b.size - inter)
}

/**
 * Mean pairwise word-set Jaccard distance over a population of strategies.
 * 0 = all strategies identical, 1 = all pairwise disjoint.
 * n < 2 → 0: with fewer than two strategies there are no pairs, hence no
 * diversity signal — a documented non-case, not an error.
 *
 * ponytail: naive O(n²·w) word-set Jaccard, fine at ~100 agents × ~300 words;
 * upgrade path: min-hash if population or strategy length grows an order of
 * magnitude.
 */
export function strategyDiversity(strategies: string[]): number {
  const sets = strategies.map(strategyWordSet)
  let distanceSum = 0
  let pairs = 0
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      distanceSum += jaccardDistance(sets[i]!, sets[j]!)
      pairs++
    }
  }
  return pairs === 0 ? 0 : distanceSum / pairs
}
