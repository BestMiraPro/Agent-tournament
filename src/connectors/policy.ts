import { lockFor, type ReadOnlyLock } from './presets.js'
import type { ConnectorKind, ToolPolicy } from './types.js'

/** A tool as an upstream MCP server lists it. */
export interface UpstreamTool {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [key: string]: unknown }
  [key: string]: unknown
}

export interface PolicySubject {
  lock: ReadOnlyLock | null
  builtin: boolean
  policy: ToolPolicy
}

export function policySubjectFor(c: { kind: ConnectorKind | 'builtin'; policy: ToolPolicy }): PolicySubject {
  return { lock: lockFor(c.kind), builtin: c.kind === 'builtin', policy: c.policy }
}

/**
 * - `read`: exposed unless the operator switched it off.
 * - `write`: exposed only when the connector permits it and the run opts in.
 * - `locked`: never exposed (a locked connector's tool outside its allowlist).
 */
export type ToolClass = 'read' | 'write' | 'locked'

export function classifyTool(subject: PolicySubject, tool: Pick<UpstreamTool, 'name' | 'annotations'>): ToolClass {
  if (subject.lock) return subject.lock.readAllowlist.includes(tool.name) ? 'read' : 'locked'
  if (subject.builtin) return 'read'
  return tool.annotations?.readOnlyHint === true ? 'read' : 'write'
}

/**
 * The tools an agent may list and call. The bridge applies this to `tools/list` and again to every `tools/call`.
 * A locked connector's set is its allowlist intersected with what the upstream lists, minus what the operator switched
 * off: its stored write permissions and the run's opt-ins are never read.
 */
export function exposedToolNames(
  subject: PolicySubject,
  tools: readonly Pick<UpstreamTool, 'name' | 'annotations'>[],
  runWriteOptIns: readonly string[],
): Set<string> {
  const disabled = new Set(subject.policy.disabledTools)
  const permitted = new Set(subject.policy.writeTools)
  const optedIn = new Set(runWriteOptIns)
  const exposed = new Set<string>()
  for (const tool of tools) {
    const cls = classifyTool(subject, tool)
    if (cls === 'read' && !disabled.has(tool.name)) exposed.add(tool.name)
    else if (cls === 'write' && permitted.has(tool.name) && optedIn.has(tool.name)) exposed.add(tool.name)
  }
  return exposed
}
