import type { FileEntry } from '../core/types.js'

export interface AgentHandle {
  agentId: string
  workspacePath: string
  baseUrl: string
}

export interface ProvisionOpts {
  seedDir?: string
}

export interface Sandbox {
  provision(agentId: string, opts: ProvisionOpts): Promise<AgentHandle>
  reset(handle: AgentHandle, opts: ProvisionOpts): Promise<void>
  writeFile(handle: AgentHandle, relPath: string, content: string): Promise<void>
  readFile(handle: AgentHandle, relPath: string): Promise<string | null>
  listFiles(handle: AgentHandle): Promise<FileEntry[]>
  teardown(handle: AgentHandle): Promise<void>
}
