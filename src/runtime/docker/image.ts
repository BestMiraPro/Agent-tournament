import { docker, type ExecResult } from './cli.js'

export type DockerFn = (args: string[], timeoutMs?: number) => Promise<ExecResult>

/**
 * Ensures the agent image exists, building it if absent.
 * Building takes minutes, so the timeout is generous.
 */
export async function ensureImage(
  tag: string,
  contextDir: string,
  dockerfile: string,
  run: DockerFn = docker,
): Promise<void> {
  const inspect = await run(['image', 'inspect', tag, '-f', '{{.Id}}'], 30_000)
  if (inspect.code === 0) return

  const build = await run(['build', '-t', tag, '-f', dockerfile, contextDir], 900_000)
  if (build.code !== 0) {
    throw new Error(
      `Failed to build ${tag}: ${(build.stderr || build.stdout).slice(-500)}`,
    )
  }
}
