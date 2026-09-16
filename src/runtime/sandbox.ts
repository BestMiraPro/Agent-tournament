import type { FileEntry } from '../core/types.js'

export interface AgentHandle {
  agentId: string
  workspacePath: string
  baseUrl: string
  /**
   * Immutable identity of the runtime that executes this handle — the Docker
   * container ID for Docker workers. Absent for mock and local handles, which
   * have no container to outlive them. Termination of an old invocation is
   * resolved against this ID, never against a reusable container name.
   */
  runtimeId?: string
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
  /**
   * The OpenCode server serving this agent. With one shared local server this is empty
   * and callers use their default client; with Docker each shard has its own port.
   */
  endpoint(handle: AgentHandle): { baseUrl: string }
  teardown(handle: AgentHandle): Promise<void>
}
