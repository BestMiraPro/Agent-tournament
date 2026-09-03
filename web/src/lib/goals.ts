/**
 * flags[i] is true when the round i goal differs from the previous round's.
 * WHY: the fitness chart breaks its line at goal changes rather than drawing
 * a continuous line across unrelated goals (spec §3.2).
 */
export function goalChangeFlags(goalMdPerRound: string[]): boolean[] {
  return goalMdPerRound.map((goal, i) => i > 0 && goal !== goalMdPerRound[i - 1])
}
