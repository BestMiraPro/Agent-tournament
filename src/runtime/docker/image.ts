import { docker } from './cli.js'
import { IMAGE_INVENTORY_PATH, parseImageInventory, type ImageInventory } from '../tool-manifest.js'

export type { DockerFn } from './cli.js'
import type { DockerFn } from './cli.js'

export interface EnsureImageOptions {
  /**
   * The toolchain the image must have been built from (src/runtime/tool-manifest.ts). When
   * set, the build records it as a build arg and label, and an existing image is accepted
   * only if its label matches — a tag alone is not evidence of what is inside.
   */
  toolchainId?: string
}

/**
 * Reads the inventory the image recorded at build, in a throwaway container with no network
 * that runs nothing but `cat`. Validated against the expected toolchain, so an image that
 * lacks the research toolchain fails here, before any agent is placed on it.
 */
export async function readImageInventory(
  tag: string,
  toolchainId: string,
  run: DockerFn = docker,
): Promise<ImageInventory> {
  const r = await run(['run', '--rm', '--network', 'none', '--entrypoint', 'cat', tag, IMAGE_INVENTORY_PATH], 60_000)
  if (r.code !== 0) {
    throw new Error(`Could not read the tool inventory from ${tag}: ${(r.stderr || r.stdout).trim().slice(-300)}`)
  }
  return parseImageInventory(r.stdout, toolchainId)
}

/**
 * Ensures the agent image exists, building it if absent.
 * Building takes minutes, so the timeout is generous.
 */
export async function ensureImage(
  tag: string,
  contextDir: string,
  dockerfile: string,
  run: DockerFn = docker,
  opts: EnsureImageOptions = {},
): Promise<void> {
  const id = opts.toolchainId
  const format = id ? '{{index .Config.Labels "arena.toolchain"}}' : '{{.Id}}'
  const inspect = await run(['image', 'inspect', tag, '-f', format], 30_000)
  if (inspect.code === 0) {
    if (id) {
      const label = inspect.stdout.trim()
      if (label !== id) {
        throw new Error(
          `Image ${tag} was built from toolchain "${label}", not "${id}". ` +
            `Remove it with \`docker image rm ${tag}\` so it can be rebuilt.`,
        )
      }
    }
    return
  }

  const build = await run(
    [
      'build', '-t', tag,
      ...(id ? ['--build-arg', `TOOLCHAIN_ID=${id}`, '--label', `arena.toolchain=${id}`] : []),
      '-f', dockerfile, contextDir,
    ],
    900_000,
  )
  if (build.code !== 0) {
    // BuildKit prints the failing step's own message well before its closing summary; a short
    // tail kept only the summary and hid the reason.
    throw new Error(
      `Failed to build ${tag}: ${(build.stderr || build.stdout).slice(-2000)}`,
    )
  }
}
