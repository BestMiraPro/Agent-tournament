import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The OpenCode the tournament speaks: the 1.x server API (per-prompt model, system prompt,
 * JSON-schema output). Same version as `docker/Dockerfile.agent`, so host and shards agree.
 *
 * OpenCode 2.x moved to a different API without those three, so the tournament runs its
 * own pinned copy on the host (the `opencode-ai` dependency) instead of whatever OpenCode
 * the machine has installed.
 */
export const PINNED_OPENCODE_VERSION = '1.18.21'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** The pinned CLI from node_modules when it is installed, else `opencode` on PATH. */
export function pinnedOpencodeCommand(
  root: string = projectRoot,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string {
  const bin = join(root, 'node_modules', '.bin', platform === 'win32' ? 'opencode.cmd' : 'opencode')
  // On win32 the command is shell-interpreted (see startServer), so quote the path.
  if (exists(bin)) return platform === 'win32' ? `"${bin}"` : bin
  return 'opencode'
}

interface HostOpencode {
  command: string
  env: NodeJS.ProcessEnv
}

let host: HostOpencode = { command: pinnedOpencodeCommand(), env: {} }

/**
 * Set how the host's OpenCode server is launched: the dashboard calls this once at start,
 * for example to give the pinned server a private data folder holding bridged credentials.
 */
export function configureHostOpencode(next: Partial<HostOpencode>): void {
  host = { command: next.command ?? host.command, env: { ...host.env, ...next.env } }
}

export function hostOpencode(): HostOpencode {
  return host
}

/** Back to the defaults (tests). */
export function resetHostOpencode(): void {
  host = { command: pinnedOpencodeCommand(), env: {} }
}
