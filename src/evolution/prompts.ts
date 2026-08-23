export interface TopPerformer {
  rank: number
  strategy: string
  excerpt: string
  rationale: string
}

export interface ReflectInput {
  ownStrategy: string
  ownNotes: string
  ownRank: number
  ownScore: number
  ownRationale: string
  topPerformers: TopPerformer[]
  metaDigest: string
  nextGoal: string
  goalChanged: boolean
  strategyCharCap: number
}

export function buildReflectPrompt(i: ReflectInput): string {
  const leaders = i.topPerformers.flatMap((t) => [
    `--- Rank ${t.rank} ---`,
    `TOP STRATEGY: ${t.strategy}`,
    `Their work: ${t.excerpt}`,
    `Judge said: ${t.rationale}`,
  ])

  return [
    'You are an agent competing in an evolutionary tournament.',
    'You have just been scored. Rewrite your strategy to score higher next round.',
    '',
    `YOUR RESULT: rank ${i.ownRank}, score ${i.ownScore}`,
    `Judge said about you: ${i.ownRationale}`,
    '',
    `YOUR STRATEGY: ${i.ownStrategy}`,
    `YOUR NOTES: ${i.ownNotes}`,
    '',
    'WHAT WON THIS ROUND:',
    ...leaders,
    '',
    `WHY THEY WON: ${i.metaDigest}`,
    '',
    ...(i.goalChanged
      ? ['GOAL HAS CHANGED. Your next goal is:', i.nextGoal, '']
      : ['Next goal (unchanged):', i.nextGoal, '']),
    `Rewrite your strategy. Keep it under ${i.strategyCharCap} characters.`,
    'Borrow what works from the leaders, but do not copy blindly — you must beat them.',
    'Update your notes with anything worth remembering.',
    '',
    'Respond with JSON only, in exactly this shape:',
    '{"strategy_md":"...","notes_md":"...","temperature":0.7}',
  ].join('\n')
}
