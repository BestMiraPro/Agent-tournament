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
  // Lowercase + whitespace-tokenize; empty/whitespace-only strategies become
  // empty sets (the '' split artifact is dropped by filter).
  const sets = strategies.map((s) => new Set(s.toLowerCase().split(/\s+/).filter(Boolean)))
  let distanceSum = 0
  let pairs = 0
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i]!
      const b = sets[j]!
      let similarity: number
      if (a.size === 0 && b.size === 0) {
        // Two empty sets are identical, not 0/0 — count them as similarity 1.
        similarity = 1
      } else {
        let inter = 0
        for (const word of a) if (b.has(word)) inter++
        // |A ∪ B| = |A| + |B| − |A ∩ B|; non-zero here because at least one set is non-empty.
        similarity = inter / (a.size + b.size - inter)
      }
      distanceSum += 1 - similarity
      pairs++
    }
  }
  return pairs === 0 ? 0 : distanceSum / pairs
}