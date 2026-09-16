import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { FileEntry } from '../../core/types.js'
import type { AgentHandle, ProvisionOpts, Sandbox } from '../sandbox.js'
import { resolveInWorkspace, seedWorkspace } from '../workspace-path.js'
import { describeShards, planShards, shardIndexOf, type Placement, type Shard } from './shard.js'

export interface StartedContainer {
  name: string
  baseUrl: string
  shardIndex: number
  /** The daemon's identity for the worker, when starting it reported one. */
  containerId?: string
  /** A protected shard's gateway, removed and verified together with the worker. */
  gatewayName?: string
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
  /** `protected` refuses any round that would put two agents in one container. Default shared. */
  isolation?: 'protected' | 'shared'
  startContainer: (shardIndex: number, hostDir: string) => Promise<StartedContainer>
  stopContainer: (name: string) => Promise<void>
  /**
   * Confirms an original instance is gone, by container ID (or name when the
   * daemon never reported an ID). Wired to the same seam the runner uses for
   * termination evidence. Without it a resolved removal is the only proof, as
   * before; with it, a warning-only removal that left the instance running is
   * treated as the failure it is.
   */
  runtimeStateOf?: (id: string) => Promise<'running' | 'stopped' | 'unknown'>
  /** Reports non-fatal problems — notably a container that could not be stopped. */
  onWarning?: (message: string) => void
}

/**
 * Ownership key for one started instance: the daemon's immutable ID when the
 * start reported one, the reusable name otherwise. Names are for messages only —
 * a later round may reuse a name for a different instance, so removal is
 * confirmed against this key and concurrent removals of different instances
 * never join each other.
 */
function ownershipKey(container: Pick<StartedContainer, 'name' | 'containerId'>): string {
  return container.containerId ?? container.name
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
  /** Every started instance still owned, keyed by immutable container ID.
   *  Successes are pruned on removal, so this holds current resources plus
   *  unresolved cleanup failures — never total rounds completed. */
  private owned = new Map<string, StartedContainer>()
  /** In-flight removals, so two callers reaching one instance issue a single attempt. */
  private stopAttempts = new Map<string, Promise<boolean>>()
  /** The in-flight per-round cleanup, joined by repeated or concurrent calls. */
  private releaseInFlight: Promise<void> | null = null
  private disposed = false

  constructor(private opts: DockerSandboxOptions) {}

  /** Must be called once with the full population before provisioning. */
  async planFor(agentIds: readonly string[]): Promise<void> {
    if (this.disposed) throw new Error('docker sandbox has been disposed')
    // Checked every round, not only at setup: manual additions and an evolved population can
    // outgrow the containers a run was admitted with.
    if (this.opts.isolation === 'protected' && agentIds.length > this.opts.maxContainers) {
      throw new Error(
        `Protected isolation needs one container per agent, but this round has ${agentIds.length} agents ` +
          `and ${this.opts.maxContainers} containers. Remove agents before the next round, or start a run with more containers.`,
      )
    }
    this.shards = planShards(agentIds, this.opts.maxContainers)
  }

  /** The current plan: each container, its agents, and whether they share it. */
  placement(): Placement[] {
    return describeShards(this.shards)
  }

  /** The container an agent's shard is running in, or null before it starts or when unplanned. */
  containerNameFor(agentId: string): string | null {
    const shardIndex = shardIndexOf(this.shards, agentId)
    if (shardIndex === null) return null
    return this.containers.get(shardIndex)?.name ?? null
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
      this.containers.set(shardIndex, container)
      this.owned.set(ownershipKey(container), container)
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
      runtimeId: container.containerId,
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
   * Removes one owned instance, confirmed against its original identity.
   *
   * A throwing `stopContainer` used to abort `disposeAll` mid-loop, so one unstoppable
   * container stranded every container after it — the exact outcome disposal exists to
   * prevent. The failure is reported instead and the instance stays owned for retry.
   *
   * A resolved removal alone is not proof either: the warning-only remover resolves
   * after reporting a failure internally. When `runtimeStateOf` is wired, the original
   * worker instance (by container ID) and its gateway must both read back as gone;
   * anything else — still running, or unknown — keeps the instance owned. True on
   * confirmed removal, false when ownership was retained for retry.
   */
  private stopOnce(container: StartedContainer): Promise<boolean> {
    const key = ownershipKey(container)
    // Already released: each instance is removed at most once, and successes are
    // pruned from ownership, so a second call is a no-op rather than a new removal.
    if (!this.owned.has(key)) return Promise.resolve(true)

    // Concurrent callers join one attempt rather than each issuing their own stop;
    // teardown and disposeAll can reach the same instance at the same time.
    const inFlight = this.stopAttempts.get(key)
    if (inFlight) return inFlight

    const attemptHolder: { current: Promise<boolean> | null } = { current: null }
    const attempt = (async (): Promise<boolean> => {
      try {
        try {
          await this.opts.stopContainer(container.name)
        } catch (e) {
          this.opts.onWarning?.(
            `Could not stop container ${container.name}: ${(e as Error).message}. ` +
              `It may still be running — check with \`docker ps -a --filter name=${container.name}\`.`,
          )
          return false
        }
        if (!(await this.verifyGone(container))) return false
        this.owned.delete(key)
        return true
      } finally {
        if (this.stopAttempts.get(key) === attemptHolder.current) this.stopAttempts.delete(key)
      }
    })()
    attemptHolder.current = attempt
    this.stopAttempts.set(key, attempt)
    return attempt
  }

  /**
   * Confirms the original worker instance and its gateway are gone. True when both
   * read back as removed; false (after reporting) when either is still present or
   * its state cannot be established. Without a verifier there is nothing stricter
   * than the removal itself, so it passes as before.
   */
  private async verifyGone(container: StartedContainer): Promise<boolean> {
    const verify = this.opts.runtimeStateOf
    if (!verify) return true
    const stateOf = async (id: string): Promise<'running' | 'stopped' | 'unknown'> => {
      try {
        return await verify(id)
      } catch {
        return 'unknown'
      }
    }
    const fail = (detail: string): boolean => {
      this.opts.onWarning?.(
        `Could not confirm removal of container ${container.name}: ${detail}. ` +
          `It stays owned for retry and capacity stays reserved — check with \`docker ps -a --filter name=${container.name}\`.`,
      )
      return false
    }
    const worker = await stateOf(container.containerId ?? container.name)
    if (worker !== 'stopped') {
      return fail(
        worker === 'running'
          ? `the original instance${container.containerId ? ` ${container.containerId.slice(0, 12)}` : ''} is still running`
          : 'Docker could not establish whether the original instance stopped',
      )
    }
    if (container.gatewayName) {
      const gateway = await stateOf(container.gatewayName)
      if (gateway !== 'stopped') {
        return fail(
          gateway === 'running'
            ? `its gateway ${container.gatewayName} is still running`
            : `Docker could not establish whether its gateway ${container.gatewayName} stopped`,
        )
      }
    }
    return true
  }

  /**
   * Recycles every owned worker between rounds: removes each instance and its
   * gateway with the same strict confirmation as disposal, then drops per-round
   * state so the next round provisions fresh workers.
   *
   * Nonterminal, unlike `disposeAll`: later `planFor` and `provision` calls work
   * normally. Workspaces on disk and all database records are untouched — only
   * containers and in-memory handles go. Failed instances stay owned (and keep
   * their capacity reserved upstream) for the next round's retry; the error names
   * them. Repeated or concurrent calls join the same in-flight attempt.
   */
  async releaseRound(): Promise<void> {
    if (this.disposed) throw new Error('docker sandbox has been disposed')
    if (this.releaseInFlight) return this.releaseInFlight
    const attempt = (async (): Promise<void> => {
      // Starts already handed to the container boundary are ours even if they have
      // not returned yet. Wait for them to register so cleanup cannot lose them.
      await Promise.allSettled([...this.pendingStarts.values()])
      const targets = [...this.owned.values()]
      const results = await Promise.all(targets.map((container) => this.stopOnce(container)))
      // Per-round state only: the next round restarts every shard fresh, which is
      // the point — no OpenCode conversation memory survives. `owned` keeps only
      // the failures, each still eligible for one new removal on retry.
      this.pendingStarts.clear()
      this.containers.clear()
      this.live.clear()
      const failed = targets.filter((_, i) => !results[i])
      if (failed.length > 0) {
        throw new Error(
          `Could not release ${failed.length} worker container(s) between rounds: ` +
            `${failed.map((c) => c.name).join(', ')}. ` +
            `They stay owned for retry and capacity stays reserved.`,
        )
      }
    })()
    this.releaseInFlight = attempt
    try {
      await attempt
    } finally {
      if (this.releaseInFlight === attempt) this.releaseInFlight = null
    }
  }

  /**
   * Stops every owned instance, regardless of `live` state.
   *
   * `teardown` only stops a shard's container once every agent that ever shared it has
   * been individually torn down — a check that depends on bookkeeping which can go wrong
   * (a sibling whose provisioning failed, a planned agent never provisioned at all, a
   * culled agent that no longer appears in the active population). `disposeAll` sidesteps
   * that fragility entirely: it is the unconditional backstop that guarantees no owned
   * instance outlives the run, retrying anything a per-round release left behind. Safe to
   * call more than once — each instance is removed at most once.
   */
  async disposeAll(): Promise<void> {
    this.disposed = true
    // Starts already handed to the container boundary are ours even if they have
    // not returned yet. Wait for them to register so disposal cannot lose them.
    await Promise.allSettled([...this.pendingStarts.values()])
    for (const container of [...this.owned.values()]) {
      await this.stopOnce(container)
    }
    this.pendingStarts.clear()
    this.containers.clear()
    this.live.clear()
  }
}
