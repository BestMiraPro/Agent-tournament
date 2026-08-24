import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const read = () => readFile(join(process.cwd(), 'docker/Dockerfile.agent'), 'utf8')

describe('Dockerfile.agent', () => {
  test('pins the opencode version rather than floating on latest', async () => {
    const df = await read()
    expect(df).toMatch(/opencode-ai@\d+\.\d+\.\d+/)
  })

  test('installs git, which opencode requires for snapshots', async () => {
    expect(await read()).toMatch(/apt-get install[^\n]*git/)
  })

  test('binds the server to 0.0.0.0 so the published port is reachable', async () => {
    expect(await read()).toContain('0.0.0.0')
  })

  test('uses /work as the working directory', async () => {
    expect(await read()).toMatch(/WORKDIR \/work/)
  })
})
