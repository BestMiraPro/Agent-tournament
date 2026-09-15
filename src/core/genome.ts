import type { Genome } from './types.js'

/**
 * Model IDs may contain multiple slashes (`wandb/deepseek-ai/DeepSeek-V4-Flash`).
 * Everything after the provider prefix is opaque — never split beyond the first slash.
 */
export function serializeGenome(g: Genome, opts: { label: string }): string {
  return [
    '---',
    `description: ${opts.label}`,
    `model: ${g.modelId}`,
    `temperature: ${g.temperature}`,
    'permission:',
    '  edit: allow',
    '  bash: allow',
    '  webfetch: deny',
    '---',
    g.strategyMd.trim(),
    '',
  ].join('\n')
}

/**
 * The OpenCode agent profile an agent runs as: `.opencode/agents/competitor.md`, selected by
 * name on every prompt.
 *
 * Frontmatter only. OpenCode turns a profile body into the agent prompt, which replaces its
 * base system prompt (the one that teaches the model its tools); the evolving strategy keeps
 * arriving through the prompt's `system` field, as before.
 *
 * The permission block is the unattended policy, verified against opencode 1.18.21 (see
 * test/fixtures/opencode-1.18.21/permission-contract.json). Rules are appended after the
 * runtime defaults and the last match wins. Every default `ask` a competitor can reach is
 * answered here, because nobody is watching to answer it: on September 13 a Muse Spark
 * agent asked for `external_directory /tmp/*` and waited until it was cancelled.
 * Denials are ordinary tool errors the agent can work around; nothing is widened beyond
 * the workspace except `readableDirs`, which become readable and not editable: a local run's
 * context folder, or a Docker worker's read-only `/context` and `/run/arena` mounts. Without
 * the Docker paths, OpenCode asked to read the mounted brief and TOOLS.md and the unattended
 * answer rejected it (September 15 relay acceptance run). Locally this is the most rules can
 * do: `bash` cannot be confined to paths, so a local agent could still change the folder.
 */
export function serializeCompetitorProfile(
  g: Genome,
  opts: { label: string; readableDirs?: readonly string[] },
): string {
  const dirs = opts.readableDirs ?? []
  return [
    '---',
    `description: ${opts.label}`,
    `model: ${g.modelId}`,
    `temperature: ${g.temperature}`,
    'permission:',
    ...permissionFor('edit', 'allow', 'deny', dirs),
    '  bash: allow',
    '  webfetch: deny',
    ...permissionFor('external_directory', 'deny', 'allow', dirs),
    '  doom_loop: deny',
    '  question: deny',
    '  read:',
    '    "*": allow',
    '    "*.env": deny',
    '    "*.env.*": deny',
    '    "*.env.example": allow',
    '---',
    '',
  ].join('\n')
}

/**
 * Absolute permission patterns covering a folder's contents, in both separator spellings:
 * which one OpenCode reports for a Windows path is not something these rules should bet on.
 */
export function folderPatterns(dir: string): string[] {
  const trimmed = dir.replace(/[\\/]+$/, '')
  const forward = `${trimmed.replace(/\\/g, '/')}/*`
  const native = `${trimmed}${trimmed.includes('\\') ? '\\' : '/'}*`
  return [...new Set([forward, native])]
}

/**
 * `key: base`, or — with folders — a map whose `*` is `base` and whose folder patterns get
 * `folder`. A map in place, never a second `key:` line: YAML keys must be unique.
 * Patterns are JSON-quoted, which is valid YAML and keeps Windows backslashes literal.
 */
function permissionFor(key: string, base: string, folder: string, dirs: readonly string[]): string[] {
  if (dirs.length === 0) return [`  ${key}: ${base}`]
  const patterns = [...new Set(dirs.flatMap(folderPatterns))]
  return [`  ${key}:`, `    "*": ${base}`, ...patterns.map((p) => `    ${JSON.stringify(p)}: ${folder}`)]
}

export function parseGenome(md: string): Genome {
  const normalized = md.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) {
    throw new Error('parseGenome: missing YAML frontmatter')
  }
  const end = normalized.indexOf('\n---', 4)
  if (end === -1) throw new Error('parseGenome: unterminated frontmatter')

  const head = normalized.slice(4, end)
  const body = normalized.slice(end + 4).replace(/^\n/, '')

  const scalar = (key: string): string | undefined => {
    // Only top-level keys: a leading space means it is nested under `permission:`.
    const line = head.split('\n').find((l) => l.startsWith(`${key}:`))
    return line?.slice(key.length + 1).trim()
  }

  const modelId = scalar('model')
  if (!modelId) throw new Error('parseGenome: missing model')
  const temperature = Number(scalar('temperature') || '0.7')
  if (!Number.isFinite(temperature)) throw new Error('parseGenome: invalid temperature')

  return { strategyMd: body.trim(), notesMd: '', modelId, temperature }
}

/** Hard cap on strategy length. Without it strategies grow every generation. */
export function capStrategy(s: string, cap: number): string {
  if (s.length <= cap) return s
  const cut = s.slice(0, cap)
  const lastSpace = cut.lastIndexOf(' ')
  return lastSpace > cap * 0.8 ? cut.slice(0, lastSpace) : cut
}
