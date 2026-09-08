/**
 * flags[i] is true when the round i goal differs from the previous round's.
 * WHY: the fitness chart breaks its line at goal changes rather than drawing
 * a continuous line across unrelated goals (spec §3.2).
 */
export function goalChangeFlags(goalMdPerRound: string[]): boolean[] {
  return goalMdPerRound.map((goal, i) => i > 0 && goal !== goalMdPerRound[i - 1])
}

export interface ComparableRound {
  goalMd: string
  scoreScale: string
}

/**
 * Splits a historical series whenever its stored comparison basis changes.
 * Goal equality intentionally matches goalChangeFlags: exact stored Markdown.
 */
export function comparableRoundSegments<T extends ComparableRound>(rounds: T[]): T[][] {
  const segments: T[][] = []
  for (const round of rounds) {
    const current = segments.at(-1)
    const previous = current?.at(-1)
    if (!current || !previous || previous.goalMd !== round.goalMd || previous.scoreScale !== round.scoreScale) {
      segments.push([round])
    } else {
      current.push(round)
    }
  }
  return segments
}

export function latestComparableSegment<T extends ComparableRound>(rounds: T[]): T[] {
  return comparableRoundSegments(rounds).at(-1) ?? []
}
