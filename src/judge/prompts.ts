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

/**
 * Neutralizes any agent-controlled `<submission>` / `</submission>` marker so a
 * submission body can never forge or close a `<submission ref="...">` block boundary.
 * Only that specific tag name is touched — ordinary `<`/`>` in code or XML/HTML
 * snippets is left exactly as written so the judge sees the real content.
 */
function escapeSubmissionMarkers(text: string): string {
  return text.replace(/<\/?\s*submission/gi, (m) => `&lt;${m.slice(1)}`)
}

/**
 * Caps the number of manifest entries so a submission with an unbounded number of
 * files cannot blow the judge's context or cost (the manifest is appended after
 * `truncate` runs on the submission body, so it is otherwise uncapped). Each file
 * path is agent-controlled and untrusted, so it goes through the same
 * `<submission>`-marker escaping as the submission body itself.
 */
const MAX_MANIFEST_FILES = 50

function buildManifest(files: readonly FileEntry[]): string {
  if (files.length === 0) return ''
  const shown = files.slice(0, MAX_MANIFEST_FILES)
  const entries = shown.map((f) => `${escapeSubmissionMarkers(f.path)} (${f.bytes}b)`)
  const remaining = files.length - shown.length
  const suffix = remaining > 0 ? `, …and ${remaining} more` : ''
  return `\nFiles produced: ${entries.join(', ')}${suffix}`
}

export function buildScoringPrompt(
  goalMd: string,
  criteriaMd: string,
  subs: readonly AnonSubmission[],
  charCap: number,
): string {
  const blocks = subs.map((s) => {
    const manifest = buildManifest(s.files)
    const body = truncate(escapeSubmissionMarkers(s.submissionMd), charCap)
    return `<submission ref="${s.ref}">\n${body}${manifest}\n</submission>`
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
