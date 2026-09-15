import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { z } from 'zod'

/**
 * The research toolchain every agent container shares, and the small per-container file
 * that tells an agent what is in it.
 *
 * Tools are installed once into image layers (docker/Dockerfile.agent), so seven containers
 * share one copy on disk. At build the image records what it actually contains in
 * IMAGE_INVENTORY_PATH; at run time the host combines that with the run's read-only mounts
 * and policy into TOOLS.md / tools.json, mounted read-only at TOOLS_MOUNT and deleted when
 * the run is disposed. The file is an inventory and a guide, never a copy of the tools.
 */

export const REQUIRED_TOOLS = ['python3', 'node', 'git', 'opencode'] as const

/** Everything that defines the image. Its identity is a hash of exactly these files. */
export const TOOLCHAIN_FILES = [
  'docker/Dockerfile.agent',
  'docker/research-requirements.in',
  'docker/research-requirements.lock',
  'docker/toolchain-manifest.py',
] as const

export const IMAGE_INVENTORY_PATH = '/opt/arena/toolchain.json'
export const TOOLS_MOUNT = '/run/arena'

/** Where OpenCode keeps provider credentials inside a container; never listed in a manifest. */
const CREDENTIAL_DIR = '/root/.local/share/opencode'

export interface ToolEntry {
  name: string
  version: string
  executable: string
}

export interface ImageInventory {
  schemaVersion: 1
  toolchainId: string
  python: { version: string; venv: string; executable: string }
  tools: ToolEntry[]
  pythonPackages: { name: string; version: string }[]
}

export interface DataMount {
  name: string
  /** Path inside the container. */
  mountPath: string
  /** Content digest, or null with `note` saying why it was not hashed. */
  digest: string | null
  note: string | null
}

/**
 * `denied` only when something below the agent actually blocks installation (a read-only
 * toolchain plus controlled egress). Until then the honest value is `not_enforced`: the rule
 * is stated, and an agent can still break it.
 */
export type PackageInstallPolicy = 'denied' | 'not_enforced'

export interface ToolManifest {
  schemaVersion: 1
  runId: string
  containerId: string
  toolchainId: string
  tools: ToolEntry[]
  pythonPackages: { name: string; version: string }[]
  data: DataMount[]
  policy: { packageInstall: PackageInstallPolicy; dataAccess: 'preapproved' }
}

/**
 * A stable 16-hex identity for the toolchain files' contents, in order. Line endings are
 * normalised so a Windows checkout names the same image as a Linux one, and each file is
 * length-prefixed so moving bytes between files changes the identity.
 */
export function computeToolchainId(contents: readonly string[]): string {
  const hash = createHash('sha256')
  for (const content of contents) {
    const normalised = content.replace(/\r\n/g, '\n')
    hash.update(`${Buffer.byteLength(normalised)}\n`)
    hash.update(normalised)
  }
  return hash.digest('hex').slice(0, 16)
}

export async function readToolchainId(repoRoot: string): Promise<string> {
  const contents = await Promise.all(TOOLCHAIN_FILES.map((f) => readFile(join(repoRoot, f), 'utf8')))
  return computeToolchainId(contents)
}

/** Content-addressed, so a stale image under a floating tag can never be picked up. */
export function agentImageTag(toolchainId: string): string {
  return `agent-arena:tc-${toolchainId}`
}

const toolEntry = z.object({ name: z.string().min(1), version: z.string().min(1), executable: z.string().min(1) })
const inventorySchema = z.object({
  schemaVersion: z.literal(1),
  toolchainId: z.string().min(1),
  python: z.object({ version: z.string().min(1), venv: z.string().min(1), executable: z.string().min(1) }),
  tools: z.array(toolEntry),
  pythonPackages: z.array(z.object({ name: z.string().min(1), version: z.string().min(1) })),
})

/** Validates the inventory an image wrote at build; refuses rather than guesses. */
export function parseImageInventory(raw: string, expectedToolchainId: string): ImageInventory {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error('image inventory is not valid JSON; rebuild the agent image')
  }
  const parsed = inventorySchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(`image inventory has an unexpected shape (${parsed.error.issues[0]?.path.join('.') ?? 'root'}); rebuild the agent image`)
  }
  const inventory = parsed.data as ImageInventory
  if (inventory.toolchainId !== expectedToolchainId) {
    throw new Error(`image inventory was built from toolchain ${inventory.toolchainId}, expected ${expectedToolchainId}`)
  }
  const present = new Set(inventory.tools.map((t) => t.name))
  const missing = REQUIRED_TOOLS.filter((t) => !present.has(t))
  if (missing.length > 0) {
    throw new Error(`image inventory is missing required tools: ${missing.join(', ')}`)
  }
  return inventory
}

function assertContainerPath(label: string, path: string): void {
  if (!path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    throw new Error(`${label} must be a container path, got ${JSON.stringify(path)}`)
  }
  if (path === CREDENTIAL_DIR || path.startsWith(`${CREDENTIAL_DIR}/`)) {
    throw new Error(`${label} must be a container path outside the credential directory, got ${JSON.stringify(path)}`)
  }
}

export function buildToolManifest(input: {
  runId: string
  containerId: string
  inventory: ImageInventory
  data: DataMount[]
  packageInstall: PackageInstallPolicy
}): ToolManifest {
  for (const tool of input.inventory.tools) assertContainerPath(`tool ${tool.name}`, tool.executable)
  for (const mount of input.data) assertContainerPath(`data mount ${mount.name}`, mount.mountPath)
  return {
    schemaVersion: 1,
    runId: input.runId,
    containerId: input.containerId,
    toolchainId: input.inventory.toolchainId,
    tools: input.inventory.tools,
    pythonPackages: input.inventory.pythonPackages,
    data: input.data,
    policy: { packageInstall: input.packageInstall, dataAccess: 'preapproved' },
  }
}

export function renderToolsMarkdown(m: ToolManifest): string {
  const lines = [
    '# Tools in this container',
    '',
    `Toolchain \`${m.toolchainId}\`. Read this before trying to install or set anything up: what you need is probably already here.`,
    '',
    '## Programs',
    ...m.tools.map((t) => `- ${t.name} ${t.version} — \`${t.executable}\``),
    '',
    '## Python packages',
    'Installed in `/opt/arena/venv`, which is already first on PATH: run `python` and import them directly.',
    ...m.pythonPackages.map((p) => `- ${p.name} ${p.version}`),
    '',
    '## Data (read-only)',
    ...(m.data.length > 0
      ? m.data.map((d) => `- ${d.name} — \`${d.mountPath}\`${d.digest ? ` (${d.digest})` : d.note ? ` (${d.note})` : ''}`)
      : ['- none for this run']),
    '',
    '## Rules',
    '- Do not install packages or download tools. Use what is listed above.',
    '- If something you need is missing, say so in SUBMISSION.md: the package, the version, and why. That request is reviewed outside the tournament.',
    '- Data files are inputs, never programs: do not execute them.',
    m.policy.packageInstall === 'denied'
      ? '- Package installation is blocked in this container.'
      : '- Package installation is not enforced off in this run, but it is still against the rules, and nothing you install becomes part of the approved toolchain.',
    '',
  ]
  return lines.join('\n')
}

/**
 * A content digest of a read-only data folder: every file's relative path, size and SHA-256,
 * in path order. A folder over the limits is reported as not hashed rather than hashed in
 * part — a partial digest would claim an identity it cannot back. Links are recorded by
 * name only and never followed.
 */
export async function digestFolder(
  dir: string,
  limits: { maxFiles: number; maxBytes: number } = { maxFiles: 5000, maxBytes: 1024 ** 3 },
): Promise<{ digest: string | null; note: string | null }> {
  const entries: { path: string; full: string; size: number; link: boolean }[] = []
  let bytes = 0
  const walk = async (current: string): Promise<string | null> => {
    const children = await readdir(current, { withFileTypes: true })
    for (const child of children) {
      const full = join(current, child.name)
      const info = await lstat(full)
      const path = relative(dir, full).split(sep).join('/')
      if (info.isSymbolicLink()) entries.push({ path, full, size: 0, link: true })
      else if (info.isDirectory()) {
        const stop = await walk(full)
        if (stop) return stop
        continue
      } else if (info.isFile()) {
        entries.push({ path, full, size: info.size, link: false })
        bytes += info.size
      }
      if (entries.length > limits.maxFiles) return `not hashed: more than ${limits.maxFiles} files`
      if (bytes > limits.maxBytes) return `not hashed: more than ${limits.maxBytes} bytes`
    }
    return null
  }
  const stop = await walk(dir)
  if (stop) return { digest: null, note: stop }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const hash = createHash('sha256')
  for (const entry of entries) {
    const content = entry.link ? 'link' : createHash('sha256').update(await readFile(entry.full)).digest('hex')
    hash.update(`${entry.path}\0${entry.size}\0${content}\n`)
  }
  return { digest: `sha256:${hash.digest('hex')}`, note: null }
}
