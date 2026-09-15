import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { folderPatterns } from '../../core/genome.js'

/** The profile criteria and judge calls select by name; OpenCode names agents by file. */
export const GRADER_AGENT = 'grader'

/**
 * The grader's session directory, a sibling of every agent workspace under the workspace
 * root. It holds nothing but the profile, so the grader cannot browse agents' work from it;
 * Docker shards mount only `shard-N`, so no container sees it.
 */
export const GRADER_DIR = '.arena-grader'

/**
 * The OpenCode profile criteria generation and scoring run as.
 *
 * Frontmatter only, like the competitor profile: a body would replace OpenCode's base system
 * prompt, which is what teaches the model its tools. Rules are appended after the runtime
 * defaults and the last match wins (test/fixtures/opencode-1.18.21/permission-contract.json).
 *
 * It may read the run's context folder and search or open web pages to check claims. It may
 * not edit, run commands, delegate, keep a todo list, load skills, or wait for an answer
 * nobody is there to give. Before this profile those calls ran as the implicit `build` agent,
 * which may edit and run shell commands while reading untrusted submissions.
 *
 * Accepted trade-off: a submission could try to steer a fetch that carries context-folder
 * text to a third party. Rules cannot stop that without stopping useful browsing, so the
 * prompts say submissions are untrusted data and the form says to keep secrets out.
 */
export function serializeGraderProfile(contextDir: string | null): string {
  return [
    '---',
    'description: tournament grader',
    'permission:',
    ...['read', 'glob', 'grep', 'list', 'webfetch', 'websearch'].map((p) => `  ${p}: allow`),
    ...['edit', 'bash', 'task', 'todowrite', 'skill', 'question', 'doom_loop'].map((p) => `  ${p}: deny`),
    ...(contextDir
      ? [
          '  external_directory:',
          '    "*": deny',
          ...folderPatterns(contextDir).map((p) => `    ${JSON.stringify(p)}: allow`),
        ]
      : ['  external_directory: deny']),
    '---',
    '',
  ].join('\n')
}

/** Writes the profile under the workspace root and returns the directory grader calls use. */
export function writeGraderProfile(workspaceRoot: string, contextDir: string | null): string {
  const dir = join(workspaceRoot, GRADER_DIR)
  const agents = join(dir, '.opencode', 'agents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, `${GRADER_AGENT}.md`), serializeGraderProfile(contextDir), 'utf8')
  return dir
}
