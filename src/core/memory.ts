/**
 * Docker-style memory limits ("512m", "1g"), as bytes.
 *
 * Pure and dependency-free so the run spec can validate a limit without importing the
 * docker runtime, while the capacity preflight reads the very same parser. Two parsers for
 * one format would let the spec accept a value the preflight then cannot read.
 */
export function parseMemoryLimit(limit: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg])b?$/i.exec(limit.trim())
  if (!m) throw new Error(`Unparseable memory limit "${limit}"`)
  const n = Number(m[1])
  const unit = m[2]!.toLowerCase()
  const mult = unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : 1024 ** 3
  return Math.round(n * mult)
}

/**
 * The smallest container memory the run spec accepts.
 *
 * Measured rather than guessed: one idle agent container — the opencode server listening,
 * no agent work yet — settled at 250-267 MiB on Docker Desktop. A 256m limit would leave an
 * agent at its ceiling before it ran a single tool, and the kill that follows is recorded
 * against the agent instead of the setting. 512m leaves about as much again for the work
 * itself. That is enough to start; whether it is enough under real agent load has not been
 * measured, which is why the default stays at 1g.
 */
export const MIN_CONTAINER_MEMORY = '512m'
export const MIN_CONTAINER_MEMORY_BYTES = parseMemoryLimit(MIN_CONTAINER_MEMORY)
