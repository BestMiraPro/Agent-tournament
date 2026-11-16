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

/** What one collaboration member did and how its team scored, for rewriting its strategy. */
export interface TeamReflectInput {
  ownStrategy: string
  ownNotes: string
  teamScore: number
  teamSize: number
  /** The judge's rationale for the team's work. */
  teamRationale: string
  metaDigest: string
  /** This member's own channel posts this round, oldest first. */
  ownPosts: string[]
  /** Files this member's activity showed it writing. */
  ownFiles: string[]
  ownToolCalls: number
  nextGoal: string
  strategyCharCap: number
}

const TEAM_MARKERS = /^(YOUR STRATEGY|YOUR NOTES|TOP STRATEGY|WHY THEY WON|YOUR RESULT|TEAM RESULT|YOUR CONTRIBUTION|YOUR POSTS):/gim
const MAX_REFLECT_POSTS = 10
const MAX_REFLECT_POST_CHARS = 300
const MAX_REFLECT_FILES = 30

function escapeTeamMarkers(text: string): string {
  return text.replace(TEAM_MARKERS, (m) => `[${m.slice(0, -1)}]:`)
}

/**
 * Reflection for a collaboration member: no leaders to imitate and nobody to beat, only the
 * team's score, what the judge said about the team's work, and what this member itself did —
 * its posts and the files its activity shows. Agent-authored text is escaped as above.
 */
export function buildTeamReflectPrompt(i: TeamReflectInput): string {
  const posts = i.ownPosts.slice(-MAX_REFLECT_POSTS).map((p) => {
    const one = p.replace(/\s+/g, ' ').trim()
    return `- ${escapeTeamMarkers(one.length > MAX_REFLECT_POST_CHARS ? `${one.slice(0, MAX_REFLECT_POST_CHARS)}…` : one)}`
  })
  const files = i.ownFiles.slice(0, MAX_REFLECT_FILES)
  return [
    `You are one member of a team of ${i.teamSize} AI agents that work on one goal together, round after round, in a shared folder.`,
    'Your team has just been scored on the output folder it built. Rewrite your own strategy so the team does better next round.',
    '',
    `TEAM RESULT: score ${i.teamScore} of 100`,
    `Judge said about the team's work: ${escapeTeamMarkers(i.teamRationale)}`,
    `What decided it: ${escapeTeamMarkers(i.metaDigest)}`,
    '',
    `YOUR STRATEGY: ${escapeTeamMarkers(i.ownStrategy)}`,
    `YOUR NOTES: ${escapeTeamMarkers(i.ownNotes)}`,
    '',
    `YOUR CONTRIBUTION: ${i.ownToolCalls} tool call(s) observed; files you wrote: ${files.length > 0 ? escapeTeamMarkers(files.join(', ')) : 'none observed'}${i.ownFiles.length > files.length ? ` (+${i.ownFiles.length - files.length} more)` : ''}.`,
    `YOUR POSTS: ${posts.length === 0 ? 'none' : ''}`,
    ...posts,
    '',
    'Next goal (unchanged):',
    i.nextGoal,
    '',
    `Rewrite your strategy. Keep it under ${i.strategyCharCap} characters.`,
    'Think about how you work with your teammates as well as what you build: dividing the work, using the channel, and keeping output/README.md accurate.',
    'Update your notes with anything worth remembering.',
    '',
    'Respond with JSON only, in exactly this shape:',
    '{"strategy_md":"...","notes_md":"...","temperature":0.7}',
  ].join('\n')
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
