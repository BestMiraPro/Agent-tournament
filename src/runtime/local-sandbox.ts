import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { FileEntry } from '../core/types.js'
import type { AgentHandle, ProvisionOpts, Sandbox } from './sandbox.js'
import { resolveInWorkspace, seedWorkspace } from './workspace-path.js'

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

  /**
   * Rejects an agent-supplied path that escapes the workspace textually or crosses a
   * link on any component. Anchored at the sandbox root so the agent's own workspace
   * directory is checked too. See `resolveInWorkspace` for the residual race.
   */
  private safeJoin(h: AgentHandle, relPath: string): Promise<string> {
    return resolveInWorkspace(h.workspacePath, relPath, this.root)
  }

  async provision(agentId: string, opts: ProvisionOpts): Promise<AgentHandle> {
    const dir = this.dirFor(agentId)
    await seedWorkspace(dir, opts.seedDir)
    this.live.add(agentId)
    return { agentId, workspacePath: dir, baseUrl: '' }
  }

  /**
   * Deliberately does NOT go through `safeJoin`: if the workspace directory has itself
   * been replaced by a link, refusing here would let one agent fail the round for
   * everyone. `rm` unlinks a link rather than following it, so removing the link and
   * recreating a real directory both repairs the workspace and destroys nothing outside
   * it — a strictly better outcome than a thrown round.
   */
  async reset(handle: AgentHandle, opts: ProvisionOpts): Promise<void> {
    this.assertLive(handle)
    await rm(handle.workspacePath, { recursive: true, force: true })
    await seedWorkspace(handle.workspacePath, opts.seedDir)
  }

  async writeFile(handle: AgentHandle, relPath: string, content: string): Promise<void> {
    this.assertLive(handle)
    const target = await this.safeJoin(handle, relPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  async readFile(handle: AgentHandle, relPath: string): Promise<string | null> {
    this.assertLive(handle)
    try {
      return await readFile(await this.safeJoin(handle, relPath), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  async listFiles(handle: AgentHandle): Promise<FileEntry[]> {
    this.assertLive(handle)
    const out: FileEntry[] = []
    const walk = async (dir: string): Promise<void> => {
      await this.safeJoin(handle, relative(handle.workspacePath, dir))
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        // `.opencode` is runtime plumbing we ourselves write into the agent's workspace
        // (the genome, and OpenCode's own installed node_modules). It must stay writable
        // and readable — writeFile/readFile are untouched — but listFiles feeds the
        // judge's file manifest, and hundreds of node_modules paths would crowd out the
        // agent's actual output there. Only this literal directory name is skipped;
        // other dotfiles (.gitignore, .env.example, ...) are real agent output and stay.
        if (e.isDirectory() && e.name === '.opencode') continue
        const full = join(dir, e.name)
        // Existing links are omitted; traversed entries are checked again below.
        if (e.isDirectory()) {
          await walk(full)
        } else if (e.isFile()) {
          const s = await stat(await this.safeJoin(handle, relative(handle.workspacePath, full)))
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

  endpoint(_handle: AgentHandle): { baseUrl: string } {
    return { baseUrl: '' }
  }

  async teardown(handle: AgentHandle): Promise<void> {
    this.live.delete(handle.agentId)
  }
}
