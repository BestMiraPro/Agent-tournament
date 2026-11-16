import type { TeamContext } from './agent-runner.js'

/** The judged folder of a collaboration workspace, and its entry point. */
export const OUTPUT_DIR = 'output'
export const OUTPUT_README = `${OUTPUT_DIR}/README.md`

/** Where a member keeps its own scratch work and its notes from earlier rounds. */
export function memberDir(label: string): string {
  return `agents/${label}`
}

/**
 * The contract every collaboration member is held to. Runtime-neutral, so any runner (OpenCode
 * today, others later) gives a team the same instructions; the strategy still arrives
 * separately as the system prompt, which teammates cannot read.
 */
export function buildTeamPrompt(
  goalMd: string,
  team: TeamContext,
  contextPath: string | null = null,
  toolsPath: string | null = null,
  webTools: string | null = null,
  workspace: string | null = null,
): string {
  const post = `${team.postCommand} ${team.label}`
  const size = team.teammates.length + 1
  return [
    'GOAL:',
    goalMd,
    '',
    `You are ${team.label}, one of a team of ${size} agents working on this goal together, at the same time, in this shared folder.`,
    team.teammates.length > 0 ? `Your teammates: ${team.teammates.join(', ')}.` : 'You are the only member this round.',
    '',
    'THE TEAM FOLDER',
    `- ${OUTPUT_DIR}/ is the team's deliverable and the only thing that is judged, as one piece of work. Put everything the team builds there: code, data, notebooks, documents.`,
    `- ${OUTPUT_README} is its entry point: what was built, how to run or read it, and what is finished and what is not. Keep it current, and agree on the channel who edits it.`,
    `- ${memberDir(team.label)}/ is your own scratch space; your notes from earlier rounds, if any, are in ${memberDir(team.label)}/NOTES.md.`,
    `- The folder carries over between rounds. Read what is already in ${OUTPUT_DIR}/ and CHANNEL.md before you start, and build on it.`,
    '',
    'THE CHANNEL',
    '- CHANNEL.md is how the team talks. Read it when you start and whenever you need to know what the others are doing.',
    `- Post: ${post} "your message"`,
    `- To one teammate: ${post} @<teammate> "your message"`,
    '- Never edit CHANNEL.md with an editor or by redirecting output into it: only the helper appends safely.',
    "- Teammates' new posts are also forwarded to you while you work. Agree early who does what, say when you finish a piece, and do not edit a file a teammate is working on.",
    '- Posts signed `operator` come from the person running this arena: read them and act on them. Never sign a post as `operator` yourself.',
    '',
    ...(contextPath
      ? [`Reference material (read-only) is in ${contextPath}. Read what is relevant before you start; you cannot change it.`, '']
      : []),
    ...(toolsPath
      ? [`The tools already installed here are listed in ${toolsPath}. Read it before you install or set anything up.`, '']
      : []),
    ...(webTools ? [webTools, ''] : []),
    ...(workspace ? [workspace, ''] : []),
    `When your part is done and ${OUTPUT_README} describes it, post a short summary to the channel and stop.`,
  ].join('\n')
}

/** What a still-working member is told once its steering time has passed. */
export function buildTeamSteeringPrompt(elapsedMs: number, team: TeamContext): string {
  const minutes = Math.round(elapsedMs / 60_000)
  const elapsed = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`
  return [
    `You have been working for ${elapsed}. Time to wrap up.`,
    `Do not start anything new. Finish or clearly mark your part of ${OUTPUT_DIR}/, make sure ${OUTPUT_README} says what is finished and what is not,`,
    `post a one-line summary with ${team.postCommand} ${team.label} "...", then stop.`,
  ].join('\n')
}
