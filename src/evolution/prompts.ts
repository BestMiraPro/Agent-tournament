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

const MARKERS = /^(YOUR STRATEGY|YOUR NOTES|TOP STRATEGY|WHY THEY WON|YOUR RESULT):/gim

/**
 * Neutralizes the prompt's structural markers inside agent-authored text.
 *
 * Every interpolated field here is written by an agent, and top-K strategies are shown to
 * every other reflecting agent — so one winner can write into the mutation prompt of the
 * entire population. Agents are selected on score and mutate toward whatever wins, which
 * makes this a channel under continuous optimization pressure.
 */
function escapeMarkers(text: string): string {
  return text.replace(MARKERS, (m) => `[${m.slice(0, -1)}]:`)
}

export function buildReflectPrompt(i: ReflectInput): string {
  const leaders = i.topPerformers.flatMap((t) => [
    `--- Rank ${t.rank} ---`,
    `TOP STRATEGY: ${escapeMarkers(t.strategy)}`,
    `Their work: ${escapeMarkers(t.excerpt)}`,
    `Judge said: ${escapeMarkers(t.rationale)}`,
  ])

  return [
    'You are an agent competing in an evolutionary tournament.',
    'You have just been scored. Rewrite your strategy to score higher next round.',
    '',
    `YOUR RESULT: rank ${i.ownRank}, score ${i.ownScore}`,
    `Judge said about you: ${escapeMarkers(i.ownRationale)}`,
    '',
    `YOUR STRATEGY: ${escapeMarkers(i.ownStrategy)}`,
    `YOUR NOTES: ${escapeMarkers(i.ownNotes)}`,
    '',
    'WHAT WON THIS ROUND:',
    ...leaders,
    '',
    `WHY THEY WON: ${escapeMarkers(i.metaDigest)}`,
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
