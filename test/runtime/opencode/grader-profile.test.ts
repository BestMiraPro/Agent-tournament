import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  GRADER_AGENT,
  GRADER_DIR,
  SEALED_DIR,
  sealedArtifactWriter,
  serializeGraderProfile,
  writeGraderProfile,
} from '../../../src/runtime/opencode/grader-profile.js'

describe('grader profile', () => {
  test('frontmatter only: reads and browses, never edits, runs or delegates', () => {
    const md = serializeGraderProfile(null)
    expect(md.startsWith('---\n')).toBe(true)
    // A body would replace OpenCode's base prompt, the one that teaches the model its tools.
    expect(md.split('\n---\n')[1] ?? '').toBe('')
    for (const allowed of ['glob', 'grep', 'list', 'webfetch', 'websearch']) {
      expect(md).toContain(`\n  ${allowed}: allow\n`)
    }
    // Reads anything except secrets files, which would otherwise wait on an unanswerable ask.
    expect(md).toContain('\n  read:\n    "*": allow\n    "*.env": deny\n    "*.env.*": deny\n    "*.env.example": allow\n')
    for (const denied of ['edit', 'bash', 'task', 'todowrite', 'skill', 'question', 'doom_loop']) {
      expect(md).toContain(`\n  ${denied}: deny\n`)
    }
    expect(md).toContain('\n  external_directory: deny\n')
  })

  test('a context folder is the only outside directory it may reach', () => {
    const md = serializeGraderProfile('C:\\Research')
    expect(md).toContain('  external_directory:\n    "*": deny\n    "C:/Research/*": allow\n    "C:\\\\Research\\\\*": allow\n')
    const keys = md.split('\n').filter((l) => /^ {2}[a-z_]+:/.test(l)).map((l) => l.trim().split(':')[0])
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('is written where the provider will look for it', () => {
    const root = mkdtempSync(join(tmpdir(), 'grader-'))
    try {
      const dir = writeGraderProfile(root, null)
      expect(dir).toBe(join(root, GRADER_DIR))
      expect(readFileSync(join(dir, '.opencode', 'agents', `${GRADER_AGENT}.md`), 'utf8')).toBe(serializeGraderProfile(null))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('sealed copy for the grader', () => {
  test("a round's stored output is written inside the grader's own folder, which it may read without any outside folder", async () => {
    const root = mkdtempSync(join(tmpdir(), 'grader-sealed-'))
    try {
      const graderDir = writeGraderProfile(root, null)
      const path = await sealedArtifactWriter(graderDir).write('round-1', [
        { path: 'output/README.md', content: '# Team output' },
        { path: 'output/src/model.py', content: 'print(1)' },
      ])
      expect(path).toBe(join(graderDir, SEALED_DIR, 'round-1', 'output'))
      expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('# Team output')
      expect(readFileSync(join(path, 'src', 'model.py'), 'utf8')).toBe('print(1)')
      expect(serializeGraderProfile(null)).toContain('external_directory: deny')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses a path that would leave the sealed folder, and an unsafe round id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grader-sealed-'))
    try {
      const writer = sealedArtifactWriter(writeGraderProfile(root, null))
      await expect(writer.write('r1', [{ path: '../../escape.md', content: 'x' }])).rejects.toThrow(/escapes/)
      await expect(writer.write('../r1', [])).rejects.toThrow(/unsafe round id/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
