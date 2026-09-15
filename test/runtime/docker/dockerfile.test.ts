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

  test('preinstalls ripgrep, which OpenCode would otherwise try to download at first use', async () => {
    expect(await read()).toMatch(/apt-get install[^\n]*ripgrep/)
  })

  test('pins the base image by digest', async () => {
    expect(await read()).toMatch(/^FROM node:24-slim@sha256:[0-9a-f]{64}$/m)
  })

  test('installs the research toolchain once, from the hash-locked file, into its own venv', async () => {
    const df = await read()
    expect(df).toMatch(/apt-get install[^\n]*python3-venv/)
    expect(df).toContain('python3 -m venv /opt/arena/venv')
    expect(df).toMatch(/pip install[^\n]*--require-hashes/)
    expect(df).toMatch(/pip install[^\n]*--only-binary=:all:/)
    expect(df).toContain('research-requirements.lock')
  })

  test('puts the venv first on PATH and keeps caches and thread pools bounded', async () => {
    const df = await read()
    expect(df).toContain('VIRTUAL_ENV=/opt/arena/venv')
    expect(df).toContain('PATH="/opt/arena/venv/bin:$PATH"')
    expect(df).toContain('MPLCONFIGDIR=/tmp/matplotlib')
    for (const v of ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS']) expect(df).toContain(`${v}=1`)
    expect(df).toContain('PIP_NO_INDEX=1')
  })

  test('records its toolchain identity and inventory at build', async () => {
    const df = await read()
    expect(df).toMatch(/^ARG TOOLCHAIN_ID$/m)
    expect(df).toContain('LABEL arena.toolchain=$TOOLCHAIN_ID')
    expect(df).toMatch(/toolchain-manifest\.py[^\n]*\/opt\/arena\/toolchain\.json/)
  })
})
