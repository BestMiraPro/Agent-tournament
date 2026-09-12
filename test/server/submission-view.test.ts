import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { submissionView } from '../../src/server/submission-view.js'

const row = {
  status: 'ok', errorText: null, submissionMd: '# answer',
  fileManifestJson: JSON.stringify([{ path: 'a.md', bytes: 3 }]),
  costUsd: 0.5, durationMs: 120,
  tokensIn: 1, tokensOut: 2, tokensCacheRead: 3, tokensCacheWrite: 4,
}

describe('submissionView', () => {
  test('parses the manifest and maps the token fields', () => {
    expect(submissionView(row as never)).toEqual({
      status: 'ok', errorText: null, submissionMd: '# answer',
      fileManifest: [{ path: 'a.md', bytes: 3 }],
      costUsd: 0.5, durationMs: 120,
      tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 },
    })
  })

  test('a half-written manifest serves null rather than throwing', () => {
    const v = submissionView({ ...row, fileManifestJson: '{not json' } as never)
    expect(v.fileManifest).toBeNull()
    expect(v.status).toBe('ok')
  })

  test('a missing manifest is null, not an empty array', () => {
    expect(submissionView({ ...row, fileManifestJson: null } as never).fileManifest).toBeNull()
  })

  /**
   * Guard, not ceremony. This shape lived twice — api.ts and export.ts — with a comment
   * telling the next person to update both, and the copies HAD already drifted (export
   * declared durationMs non-nullable against a nullable row). Two copies of one shape with
   * a note to keep them in step is how the dashboard's seed strategy silently diverged from
   * the CLI's. api.ts imports export.ts, so the cycle is what pushed the copy in; a leaf
   * module removes the excuse.
   */
  test('neither api.ts nor export.ts redefines it locally', () => {
    for (const file of ['src/server/api.ts', 'src/server/export.ts']) {
      const source = readFileSync(file, 'utf8')
      expect(source).toMatch(/from '\.\/submission-view\.js'/)
      expect(source).not.toMatch(/function submissionView\s*\(/)
      expect(source).not.toMatch(/interface SubmissionView\s*\{/)
    }
  })
})
