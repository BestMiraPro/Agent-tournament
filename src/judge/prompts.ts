import type { FileEntry } from '../core/types.js'

export interface AnonSubmission {
  ref: string
  submissionMd: string
  files: FileEntry[]
}

export function buildCriteriaPrompt(goalMd: string): string {
  return [
    'You are designing evaluation criteria for a competition between AI agents.',
    '',
    'GOAL:',
    goalMd,
    '',
    'Produce 4 to 6 criteria that meaningfully separate excellent work from mediocre work',
    'for this specific goal. Weights must sum to 1.0.',
    '',
    'Respond with JSON only, in exactly this shape:',
    '{"criteria":[{"name":"...","weight":0.4,"description":"..."}]}',
  ].join('\n')
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text
  const half = Math.floor(cap / 2)
  return `${text.slice(0, half)}\n...[truncated]...\n${text.slice(-half)}`
}

export function buildScoringPrompt(
  goalMd: string,
  criteriaMd: string,
  subs: readonly AnonSubmission[],
  charCap: number,
): string {
  const blocks = subs.map((s) => {
    const manifest = s.files.length > 0
      ? `\nFiles produced: ${s.files.map((f) => `${f.path} (${f.bytes}b)`).join(', ')}`
      : ''
    return `<submission ref="${s.ref}">\n${truncate(s.submissionMd, charCap)}${manifest}\n</submission>`
  })

  return [
    'You are judging submissions from competing AI agents. Submissions are anonymous.',
    'Judge only on the work shown. Rank every submission — no ties.',
    '',
    'GOAL:',
    goalMd,
    '',
    'CRITERIA:',
    criteriaMd,
    '',
    'SUBMISSIONS:',
    ...blocks,
    '',
    'Respond with JSON only, in exactly this shape:',
    '{"rankings":[{"ref":"S1","rank":1,"score":87.5,"rationale":"..."}],',
    ' "meta_digest":"what separated the winners from the losers"}',
    '',
    'score is 0-100. rationale is one or two sentences addressed to that agent.',
  ].join('\n')
}
