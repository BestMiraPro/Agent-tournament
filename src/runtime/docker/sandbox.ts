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
  /** Reports non-fatal problems — notably a container that could not be stopped. */
  onWarning?: (message: string) => void
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
  /** Every container ever started, keyed by name. Never pruned by `teardown`, so
   *  `disposeAll` can clean up a container even after its per-shard bookkeeping
   *  in `containers` has been removed. */
  private everStarted = new Map<string, StartedContainer>()
  private stoppedNames = new Set<string>()

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
      this.everStarted.set(container.name, container)
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

  /**
   * Stops the agent's shard container once every agent in that shard is torn down.
   *
   * Teardown is cleanup — it must never be the thing that fails a run. If the agent was
   * never part of the plan (e.g. a population change removed it before the driver got
   * around to tearing it down), this is a quiet no-op rather than a thrown error.
   */
  async teardown(handle: AgentHandle): Promise<void> {
    this.live.delete(handle.agentId)
    const shardIndex = shardIndexOf(this.shards, handle.agentId)
    if (shardIndex === null) return
    const shard = this.shards.find((s) => s.shardIndex === shardIndex)
    if (!shard) return
    if (shard.agentIds.some((id) => this.live.has(id))) return

    const container = this.containers.get(shardIndex)
    if (container) {
      this.containers.delete(shardIndex)
      await this.stopOnce(container)
    }
  }

  /**
   * Stops a container at most once, and never propagates a failure.
   *
   * A throwing `stopContainer` used to abort `disposeAll` mid-loop, so one unstoppable
   * container stranded every container after it — the exact outcome disposeAll exists to
   * prevent. The failure is reported instead: a container we could not stop is a leak the
   * user needs to know about, and the next run's orphan sweep is what will collect it.
   */
  private async stopOnce(container: StartedContainer): Promise<void> {
    if (this.stoppedNames.has(container.name)) return
    this.stoppedNames.add(container.name)
    try {
      await this.opts.stopContainer(container.name)
    } catch (e) {
      this.opts.onWarning?.(
        `Could not stop container ${container.name}: ${(e as Error).message}. ` +
          `It may still be running — check with \`docker ps -a --filter name=${container.name}\`.`,
      )
    }
  }

  /**
   * Stops every container this sandbox ever started, regardless of `live` state.
   *
   * `teardown` only stops a shard's container once every agent that ever shared it has
   * been individually torn down — a check that depends on bookkeeping which can go wrong
   * (a sibling whose provisioning failed, a planned agent never provisioned at all, a
   * culled agent that no longer appears in the active population). `disposeAll` sidesteps
   * that fragility entirely: it is the unconditional backstop that guarantees no shard
   * container outlives the run. Safe to call more than once — each container is stopped
   * at most once.
   */
  async disposeAll(): Promise<void> {
    for (const container of this.everStarted.values()) {
      await this.stopOnce(container)
    }
    this.containers.clear()
    this.live.clear()
  }
}
