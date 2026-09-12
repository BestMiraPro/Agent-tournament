import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { FileEntry } from '../../core/types.js'
import type { AgentHandle, ProvisionOpts, Sandbox } from '../sandbox.js'
import { resolveInWorkspace, seedWorkspace } from '../workspace-path.js'
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
 * different shards have separate bind mounts. Host filesystem operations reject links
 * under a stable-path assumption; see workspace-path.ts for the remaining race.
 * Set maxContainers equal to the population to avoid shared-shard writers.
 *
 * The critical distinction in this file: `AgentHandle.workspacePath` is the CONTAINER path
 * (`/work/<agentId>`), because it becomes OpenCode's `?directory=` parameter. Orchestrator
 * file operations use the HOST path. Confusing the two is the most likely bug here.
 */
export class DockerSandbox implements Sandbox {
  private shards: Shard[] = []
  private containers = new Map<number, StartedContainer>()
  private pendingStarts = new Map<number, Promise<StartedContainer>>()
  private live = new Set<string>()
  /** Every container ever started, keyed by name. Never pruned by `teardown`, so
   *  `disposeAll` can clean up a container even after its per-shard bookkeeping
   *  in `containers` has been removed. */
  private everStarted = new Map<string, StartedContainer>()
  private stoppedNames = new Set<string>()
  private disposed = false

  constructor(private opts: DockerSandboxOptions) {}

  /** Must be called once with the full population before provisioning. */
  async planFor(agentIds: readonly string[]): Promise<void> {
    if (this.disposed) throw new Error('docker sandbox has been disposed')
    this.shards = planShards(agentIds, this.opts.maxContainers)
  }

  private shardFor(agentId: string): number {
    const idx = shardIndexOf(this.shards, agentId)
    if (idx === null) {
      throw new Error(`agent ${agentId} was not included in planFor()`)
    }
    return idx
  }

  /**
   * Whether this agent is the ONLY party that could write into its workspace.
   *
   * A shard is one container with one bind mount: `shard-<n>/` on the host becomes
   * `/work/` inside, and every agent placed on that shard gets a subdirectory of it. So
   * co-tenants are not merely neighbours — each can write into the others' workspaces
   * directly. Isolation therefore means exactly one thing here: this agent is the sole
   * member of its shard, which is what `maxContainers >= populationSize` buys.
   *
   * `capture.ts` uses this to decide whether an intact submission may be certified as the
   * agent's own work, so a wrong `true` is a security failure rather than a bug: it would
   * certify a rival's substituted file as the victim's. Every branch that cannot PROVE
   * sole occupancy therefore returns false — no plan yet, an agent absent from the plan,
   * a shard record that cannot be found, or any occupant list that is not precisely this
   * one agent.
   *
   * Deliberately reads the PLAN rather than live occupancy. A co-tenant that has since
   * been torn down could still have written into this workspace earlier in the round, and
   * teardown does not un-write it. Sole occupancy has to hold for the whole round, and
   * only the plan says that.
   *
   * Never throws: an exception here would propagate through the capture path and lose the
   * submission entirely, and the caller treats a thrown check as false anyway.
   */
  isolatedWorkspace(handle: AgentHandle): boolean {
    try {
      const shardIndex = shardIndexOf(this.shards, handle.agentId)
      if (shardIndex === null) return false
      const shard = this.shards.find((s) => s.shardIndex === shardIndex)
      if (!shard) return false
      // Not `length === 1 && includes(id)`: an occupant list that somehow repeated this
      // agent is a bookkeeping state we cannot reason about, so it reads as not isolated.
      return shard.agentIds.length === 1 && shard.agentIds[0] === handle.agentId
    } catch {
      return false
    }
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

  private safeJoin(agentId: string, relPath: string): Promise<string> {
    return resolveInWorkspace(this.hostDirFor(agentId), relPath, this.opts.root)
  }

  private startShard(shardIndex: number): Promise<StartedContainer> {
    const existing = this.containers.get(shardIndex)
    if (existing) return Promise.resolve(existing)

    const pending = this.pendingStarts.get(shardIndex)
    if (pending) return pending

    const start = (async () => {
      await mkdir(this.shardHostDir(shardIndex), { recursive: true })
      const container = await this.opts.startContainer(
        shardIndex,
        this.shardHostDir(shardIndex),
      )
      // A container name can be reused after teardown. It is a newly owned
      // resource and therefore must be eligible for one new stop.
      this.stoppedNames.delete(container.name)
      this.containers.set(shardIndex, container)
      this.everStarted.set(container.name, container)
      return container
    })()
    this.pendingStarts.set(shardIndex, start)
    void start.then(
      () => {
        if (this.pendingStarts.get(shardIndex) === start) {
          this.pendingStarts.delete(shardIndex)
        }
      },
      () => {
        if (this.pendingStarts.get(shardIndex) === start) {
          this.pendingStarts.delete(shardIndex)
        }
      },
    )
    return start
  }

  async provision(agentId: string, opts: ProvisionOpts): Promise<AgentHandle> {
    if (this.disposed) throw new Error('docker sandbox has been disposed')
    const shardIndex = this.shardFor(agentId)
    await seedWorkspace(this.hostDirFor(agentId), opts.seedDir, this.opts.root)
    if (this.disposed) throw new Error('docker sandbox has been disposed')
    const container = await this.startShard(shardIndex)
    if (this.disposed) throw new Error('docker sandbox has been disposed')

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
    // Check ancestors; rm safely unlinks a final workspace junction without following it.
    await resolveInWorkspace(dirname(dir), '', this.opts.root)
    await rm(dir, { recursive: true, force: true })
    await seedWorkspace(dir, opts.seedDir, this.opts.root)
  }

  async writeFile(handle: AgentHandle, relPath: string, content: string): Promise<void> {
    this.assertLive(handle)
    const target = await this.safeJoin(handle.agentId, relPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  async readFile(handle: AgentHandle, relPath: string): Promise<string | null> {
    this.assertLive(handle)
    try {
      return await readFile(await this.safeJoin(handle.agentId, relPath), 'utf8')
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
      await this.safeJoin(handle.agentId, relative(base, dir))
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
        // Existing links are omitted; traversed entries are checked again below.
        if (e.isDirectory()) await walk(full)
        else if (e.isFile()) {
          const s = await stat(await this.safeJoin(handle.agentId, relative(base, full)))
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
    this.disposed = true
    // Starts already handed to the container boundary are ours even if they have
    // not returned yet. Wait for them to register so disposal cannot lose them.
    await Promise.allSettled([...this.pendingStarts.values()])
    for (const container of this.everStarted.values()) {
      await this.stopOnce(container)
    }
    this.pendingStarts.clear()
    this.containers.clear()
    this.live.clear()
  }
}
