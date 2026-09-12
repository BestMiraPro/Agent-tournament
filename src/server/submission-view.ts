import type { Repos } from '../db/repos.js'

export interface SubmissionView {
  status: string
  errorText: string | null
  submissionMd: string | null
  fileManifest: unknown
  costUsd: number
  durationMs: number | null
  tokens: { in: number; out: number; cacheRead: number; cacheWrite: number }
}

/**
 * The one submission shape the API and the export both serve.
 *
 * It lived twice — once in api.ts for agent-detail and round-detail, once inlined in
 * export.ts with a comment saying to update both — because api.ts imports export.ts, so
 * export.ts could not import back. A leaf module imports neither, which removes the cycle
 * and the instruction to remember. Two copies of a shape with a note to keep them in step
 * is how this project previously shipped a dashboard whose seed strategy had silently
 * diverged from the CLI's.
 */
export function submissionView(
  sub: NonNullable<ReturnType<Repos['submissions']['forAgent']>>,
): SubmissionView {
  let fileManifest: unknown = null
  if (sub.fileManifestJson) {
    try {
      fileManifest = JSON.parse(sub.fileManifestJson)
    } catch {
      // The manifest is always our own JSON; a parse failure means a half-written row —
      // serve null rather than 500 the caller.
    }
  }
  return {
    status: sub.status,
    errorText: sub.errorText,
    submissionMd: sub.submissionMd,
    fileManifest,
    costUsd: sub.costUsd,
    durationMs: sub.durationMs,
    tokens: {
      in: sub.tokensIn, out: sub.tokensOut,
      cacheRead: sub.tokensCacheRead, cacheWrite: sub.tokensCacheWrite,
    },
  }
}
