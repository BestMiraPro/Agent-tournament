import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { FileEntry } from '../../core/types.js'
import type { AgentHandle, ProvisionOpts, Sandbox } from '../sandbox.js'
import { planShards, shardIndexOf, type Shard } from './shard.js'

export interface StartedContainer {
  name: string
  baseUrl: string
  shardIndex: number
}

export interface DockerSandboxOptions {
  runId: string
  /** Host directory holding shard-N subdirectories. */
  root: string
  maxContainers: number
  image: string
  memory: string
  cpus: number
  authFile: string | null
  startContainer: (shardIndex: number, hostDir: string) => Promise<StartedContainer>
  stopContainer: (name: string) => Promise<void>
}

/**
 * Runs agents inside Docker containers, sharded.
 *
 * Agents in one shard share a container and can reach each other's workspaces; agents in
 * different shards cannot, because each shard bind-mounts only its own directory. No agent
 * can reach the host. Set maxContainers equal to the population for full isolation.
 *
 * The critical distinction in this file: `AgentHandle.workspacePath` is the CONTAINER path
 * (`/work/<agentId>`), because it becomes OpenCode's `?directory=` parameter. Orchestrator
 * file operations use the HOST path. Confusing the two is the most likely bug here.
 */
export class DockerSandbox implements Sandbox {
  private shards: Shard[] = []
  private containers = new Map<number, StartedContainer>()
  private live = new Set<string>()

  constructor(private opts: DockerSandboxOptions) {}

  /** Must be called once with the full population before provisioning. */
  async planFor(agentIds: readonly string[]): Promise<void> {
    this.shards = planShards(agentIds, this.opts.maxContainers)
  }

  private shardFor(agentId: string): number {
    const idx = shardIndexOf(this.shards, agentId)
    if (idx === null) {
      throw new Error(`agent ${agentId} was not included in planFor()`)
    }
    return idx
  }

  private shardHostDir(shardIndex: number): string {
    return join(this.opts.root, `shard-${shardIndex}`)
  }

  private hostDirFor(agentId: string): string {
    return join(this.shardHostDir(this.shardFor(agentId)), agentId)
  }

  private assertLive(h: AgentHandle): void {
    if (!this.live.has(h.agentId)) {
      throw new Error(`workspace for ${h.agentId} has been torn down`)
    }
  }

  private safeJoin(agentId: string, relPath: string): string {
    const base = resolve(this.hostDirFor(agentId))
    const target = resolve(base, relPath)
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`path "${relPath}" escapes the workspace`)
    }
    return target
  }

  private async seed(dir: string, opts: ProvisionOpts): Promise<void> {
    await mkdir(dir, { recursive: true })
    if (opts.seedDir) await cp(opts.seedDir, dir, { recursive: true })
  }

  async provision(agentId: string, opts: ProvisionOpts): Promise<AgentHandle> {
    const shardIndex = this.shardFor(agentId)
    await this.seed(this.hostDirFor(agentId), opts)

    let container = this.containers.get(shardIndex)
    if (!container) {
      await mkdir(this.shardHostDir(shardIndex), { recursive: true })
      container = await this.opts.startContainer(shardIndex, this.shardHostDir(shardIndex))
      this.containers.set(shardIndex, container)
    }

    this.live.add(agentId)
    return {
      agentId,
      // CONTAINER path — this becomes OpenCode's ?directory= parameter.
      workspacePath: `/work/${agentId}`,
      baseUrl: container.baseUrl,
    }
  }

  async reset(handle: AgentHandle, opts: ProvisionOpts): Promise<void> {
    this.assertLive(handle)
    const dir = this.hostDirFor(handle.agentId)
    await rm(dir, { recursive: true, force: true })
    await this.seed(dir, opts)
  }

  async writeFile(handle: AgentHandle, relPath: string, content: string): Promise<void> {
    this.assertLive(handle)
    const target = this.safeJoin(handle.agentId, relPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  async readFile(handle: AgentHandle, relPath: string): Promise<string | null> {
    this.assertLive(handle)
    try {
      return await readFile(this.safeJoin(handle.agentId, relPath), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  async listFiles(handle: AgentHandle): Promise<FileEntry[]> {
    this.assertLive(handle)
    const base = this.hostDirFor(handle.agentId)
    const out: FileEntry[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        // .opencode is our own plumbing, not agent output; including it would flood
        // the judge's file manifest with node_modules.
        if (e.isDirectory() && e.name === '.opencode') continue
        const full = join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.isFile()) {
          const s = await stat(full)
          out.push({ path: relative(base, full).split(sep).join('/'), bytes: s.size })
        }
      }
    }
    await walk(base)
    return out
  }

  endpoint(handle: AgentHandle): { baseUrl: string } {
    return { baseUrl: handle.baseUrl }
  }

  /** Stops the agent's shard container once every agent in that shard is torn down. */
  async teardown(handle: AgentHandle): Promise<void> {
    this.live.delete(handle.agentId)
    const shardIndex = this.shardFor(handle.agentId)
    const shard = this.shards.find((s) => s.shardIndex === shardIndex)
    if (!shard) return
    if (shard.agentIds.some((id) => this.live.has(id))) return

    const container = this.containers.get(shardIndex)
    if (container) {
      this.containers.delete(shardIndex)
      await this.opts.stopContainer(container.name)
    }
  }
}
