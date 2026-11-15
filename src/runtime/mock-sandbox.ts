import type { FileEntry } from '../core/types.js'
import { assertTeamId, type AgentHandle, type ProvisionOpts, type Sandbox, type TeamWorkspace } from './sandbox.js'

export class MockSandbox implements Sandbox {
  private spaces = new Map<string, Map<string, string>>()
  /** Collaboration workspaces by team id; they outlive any one round's handles. */
  private teams = new Map<string, Map<string, string>>()
  private seedFiles: Record<string, string>

  constructor(opts: { seedFiles?: Record<string, string> } = {}) {
    this.seedFiles = opts.seedFiles ?? {}
  }

  private space(h: AgentHandle): Map<string, string> {
    const s = this.spaces.get(h.agentId)
    if (!s) throw new Error(`workspace for ${h.agentId} has been torn down`)
    return s
  }

  private seed(agentId: string, opts: ProvisionOpts): void {
    this.spaces.set(agentId, this.seeded(opts))
  }

  private seeded(opts: ProvisionOpts): Map<string, string> {
    const files = new Map<string, string>()
    if (opts.seedDir) {
      for (const [p, c] of Object.entries(this.seedFiles)) files.set(p, c)
    }
    return files
  }

  async provisionTeam(teamId: string, agentIds: readonly string[], opts: ProvisionOpts): Promise<TeamWorkspace> {
    assertTeamId(teamId)
    let space = this.teams.get(teamId)
    const created = space === undefined
    if (!space) {
      space = this.seeded(opts)
      this.teams.set(teamId, space)
    }
    const handles = new Map<string, AgentHandle>()
    for (const agentId of agentIds) {
      this.spaces.set(agentId, space)
      handles.set(agentId, { agentId, workspacePath: `/mock/team-${teamId}`, baseUrl: `mock://team-${teamId}` })
    }
    return { handles, created }
  }

  async provision(agentId: string, opts: ProvisionOpts): Promise<AgentHandle> {
    this.seed(agentId, opts)
    return { agentId, workspacePath: `/mock/${agentId}`, baseUrl: `mock://${agentId}` }
  }

  async reset(handle: AgentHandle, opts: ProvisionOpts): Promise<void> {
    this.space(handle)
    this.seed(handle.agentId, opts)
  }

  async writeFile(handle: AgentHandle, relPath: string, content: string): Promise<void> {
    this.space(handle).set(relPath, content)
  }

  async readFile(handle: AgentHandle, relPath: string): Promise<string | null> {
    return this.space(handle).get(relPath) ?? null
  }

  async listFiles(handle: AgentHandle): Promise<FileEntry[]> {
    return [...this.space(handle).entries()].map(([path, content]) => ({
      path,
      bytes: Buffer.byteLength(content, 'utf8'),
    }))
  }

  endpoint(handle: AgentHandle): { baseUrl: string } {
    return { baseUrl: handle.baseUrl }
  }

  async teardown(handle: AgentHandle): Promise<void> {
    this.spaces.delete(handle.agentId)
  }
}
