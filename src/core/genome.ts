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
 * the workspace.
 */
export function serializeCompetitorProfile(g: Genome, opts: { label: string }): string {
  return [
    '---',
    `description: ${opts.label}`,
    `model: ${g.modelId}`,
    `temperature: ${g.temperature}`,
    'permission:',
    '  edit: allow',
    '  bash: allow',
    '  webfetch: deny',
    '  external_directory: deny',
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
