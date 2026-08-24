import type { FileEntry } from '../core/types.js'
import type { AgentHandle, ProvisionOpts, Sandbox } from './sandbox.js'

export class MockSandbox implements Sandbox {
  private spaces = new Map<string, Map<string, string>>()
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
    const files = new Map<string, string>()
    if (opts.seedDir) {
      for (const [p, c] of Object.entries(this.seedFiles)) files.set(p, c)
    }
    this.spaces.set(agentId, files)
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
