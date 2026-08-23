import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const FORBIDDEN = [
  'node:fs', 'node:sqlite', 'node:child_process', 'node:http',
  'node:net', 'node:os', 'node:path', 'fetch(',
]

describe('core purity', () => {
  test('core/ imports no I/O modules', async () => {
    const dir = join(process.cwd(), 'src/core')
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)

    const violations: string[] = []
    for (const file of files) {
      const src = await readFile(join(dir, file), 'utf8')
      for (const bad of FORBIDDEN) {
        if (src.includes(bad)) violations.push(`${file} references ${bad}`)
      }
    }
    expect(violations).toEqual([])
  })
})
