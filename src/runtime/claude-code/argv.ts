/**
 * Command lines for the Claude Code CLI (verified against 2.1.325; see
 * docs/superpowers/specs/2026-11-15-subscription-runs-design.md).
 *
 * Every value is passed as `--flag=value`: a strategy that begins with `--` stays a value instead of
 * becoming a flag, and repeated `--add-dir=` / `--disallowedTools=` accumulate.
 */

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What a competitor may use: the coding tools, without web access, subagents, scheduling or
 * workflows. Named explicitly because the CLI's default set grows between versions and includes
 * deferred web tools; names a version lacks are ignored by the CLI.
 */
export const COMPETITOR_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite', 'NotebookEdit'] as const

/** The tools that write files; each read-only folder gets a deny rule for every one of them. */
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

/**
 * Secrets files a seeded workspace may hold. Claude Code cannot re-allow a path under a deny rule,
 * so unlike the OpenCode profile `.env.example` is refused too.
 */
export const ENV_FILE_DENIALS = ['Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.env)'] as const

/** Settings every call shares: no settings files, MCP servers, slash commands, saved sessions or customisations. */
const ISOLATION_FLAGS = ['--setting-sources=', '--no-session-persistence', '--disable-slash-commands', '--safe-mode'] as const

function assertModel(model: string): void {
  if (!MODEL_RE.test(model)) throw new Error(`invalid Claude model id ${JSON.stringify(model)}`)
}

/**
 * A permission-rule pattern for everything under an absolute folder: `//abs/dir/**`. A folder whose
 * path a rule cannot hold (parentheses end the rule) is refused rather than left editable.
 */
export function folderRule(dir: string): string {
  const forward = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (forward.length === 0 || /[()]/.test(forward)) {
    throw new Error(`folder ${JSON.stringify(dir)} cannot be expressed in a Claude Code permission rule`)
  }
  return `/${forward.startsWith('/') ? forward : `/${forward}`}/**`
}

/** Read-only access to each folder: readable as a working directory, every edit tool denied there. */
function readableFolderArgs(dirs: readonly string[]): string[] {
  const out: string[] = []
  for (const dir of dirs) {
    const rule = folderRule(dir)
    out.push(`--add-dir=${dir}`)
    for (const tool of EDIT_TOOLS) out.push(`--disallowedTools=${tool}(${rule})`)
  }
  return out
}

export interface CompetitorArgsInput {
  /** The bare model (`claude-opus-5-5`, `opus`), already validated. */
  model: string
  /** The evolving strategy, appended to Claude Code's own system prompt. */
  strategy: string
  /** Folders the agent may read but not change: the context folder, the tool inventory. */
  readableDirs: readonly string[]
  sessionId: string
  /** Connectors seam: an MCP config (file or JSON) to load; none by default. */
  mcpConfig?: string | null
}

/**
 * One competitor attempt: streaming JSON in and out, unattended, confined to its workspace.
 *
 * `acceptEdits` with `--permission-prompts=none` accepts edits inside the working directories and
 * denies anything that would ask; Bash is the one tool allowed outright. (`dontAsk` with an allowed
 * `Write` accepted a write outside the workspace, so it is not used.)
 */
export function competitorArgs(input: CompetitorArgsInput): string[] {
  assertModel(input.model)
  if (!UUID_RE.test(input.sessionId)) throw new Error(`invalid session id ${JSON.stringify(input.sessionId)}`)
  return [
    '-p',
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--verbose',
    `--model=${input.model}`,
    ...(input.strategy.trim().length > 0 ? [`--append-system-prompt=${input.strategy}`] : []),
    `--tools=${COMPETITOR_TOOLS.join(',')}`,
    '--permission-mode=acceptEdits',
    '--permission-prompts=none',
    '--allowedTools=Bash',
    ...ENV_FILE_DENIALS.map((rule) => `--disallowedTools=${rule}`),
    ...readableFolderArgs(input.readableDirs),
    '--strict-mcp-config',
    ...(input.mcpConfig ? [`--mcp-config=${input.mcpConfig}`] : []),
    ...ISOLATION_FLAGS,
    `--session-id=${input.sessionId}`,
  ]
}

export interface ProviderArgsInput {
  model: string
  systemPrompt: string
  /** JSON Schema for structured output, when the caller has one. */
  schema?: unknown
  /** Folders a grading call may read (the context folder); none means no tools at all. */
  readableDirs: readonly string[]
}

/** A one-shot judge, reflect, criteria or review call: prompt on stdin, one JSON result. */
export function providerArgs(input: ProviderArgsInput): string[] {
  assertModel(input.model)
  const reads = input.readableDirs.length > 0
  return [
    '-p',
    '--output-format=json',
    `--model=${input.model}`,
    `--system-prompt=${input.systemPrompt}`,
    reads ? '--tools=Read,Glob,Grep' : '--tools=',
    ...(reads ? readableFolderArgs(input.readableDirs) : []),
    '--permission-mode=default',
    '--permission-prompts=none',
    ...(input.schema !== undefined ? [`--json-schema=${JSON.stringify(input.schema)}`] : []),
    '--strict-mcp-config',
    ...ISOLATION_FLAGS,
  ]
}
