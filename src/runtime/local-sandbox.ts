import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { FileEntry } from '../core/types.js'
import type { AgentHandle, ProvisionOpts, Sandbox } from './sandbox.js'

/**
 * Real-filesystem sandbox. Each agent gets `<root>/<agentId>` as its workspace.
 *
 * `teardown` deliberately does NOT delete the directory: an agent's files are the run's
 * artifacts and stay on disk for inspection. It only invalidates the handle.
 */
export class LocalSandbox implements Sandbox {
  private live = new Set<string>()

  constructor(private root: string) {}

  private dirFor(agentId: string): string {
    return join(this.root, agentId)
  }

  private assertLive(h: AgentHandle): void {
    if (!this.live.has(h.agentId)) {
      throw new Error(`workspace for ${h.agentId} has been torn down`)
    }
  }

  /** Guards against an agent-supplied relative path escaping its workspace. */
  private safeJoin(h: AgentHandle, relPath: string): string {
    const base = resolve(h.workspacePath)
    const target = resolve(base, relPath)
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`path "${relPath}" escapes the workspace`)
    }
    return target
  }

  private async seed(dir: string, opts: ProvisionOpts): Promise<void> {
    await mkdir(dir, { recursive: true })
    if (opts.seedDir) {
      await cp(opts.seedDir, dir, { recursive: true })
    }
  }

  async provision(agentId: string, opts: ProvisionOpts): Promise<AgentHandle> {
    const dir = this.dirFor(agentId)
    await this.seed(dir, opts)
    this.live.add(agentId)
    return { agentId, workspacePath: dir, baseUrl: '' }
  }

  async reset(handle: AgentHandle, opts: ProvisionOpts): Promise<void> {
    this.assertLive(handle)
    await rm(handle.workspacePath, { recursive: true, force: true })
    await this.seed(handle.workspacePath, opts)
  }

  async writeFile(handle: AgentHandle, relPath: string, content: string): Promise<void> {
    this.assertLive(handle)
    const target = this.safeJoin(handle, relPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  async readFile(handle: AgentHandle, relPath: string): Promise<string | null> {
    this.assertLive(handle)
    try {
      return await readFile(this.safeJoin(handle, relPath), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  async listFiles(handle: AgentHandle): Promise<FileEntry[]> {
    this.assertLive(handle)
    const out: FileEntry[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          await walk(full)
        } else if (e.isFile()) {
          const s = await stat(full)
          out.push({
            path: relative(handle.workspacePath, full).split(sep).join('/'),
            bytes: s.size,
          })
        }
      }
    }
    await walk(handle.workspacePath)
    return out
  }

  async teardown(handle: AgentHandle): Promise<void> {
    this.live.delete(handle.agentId)
  }
}
