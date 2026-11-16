import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * OpenCode 2.x keeps credentials in its own store instead of `auth.json`, so the pinned
 * 1.x server and Docker runs (which mount or relay `auth.json`) would find none. This
 * reads them through `opencode auth export` and writes the 1.x file in a private folder.
 *
 * Only active API keys carry over. OAuth logins are skipped and named: a refreshable
 * login copied into a second store would be refreshed by two programs, and the first
 * refresh would sign the other out.
 */

/** OpenCode 2's `auth export` entry, as far as this needs it. */
interface ExportEntry {
  integrationID?: unknown
  active?: unknown
  value?: { type?: unknown; key?: unknown }
}

export interface V1Auth {
  auth: Record<string, { type: 'api'; key: string }>
  /** Integrations left out, with why (never with a secret). */
  skipped: string[]
}

export function toV1Auth(exported: unknown): V1Auth {
  const auth: V1Auth['auth'] = {}
  const skipped: string[] = []
  if (!Array.isArray(exported)) return { auth, skipped: ['export was not a list'] }
  for (const raw of exported as ExportEntry[]) {
    const id = typeof raw?.integrationID === 'string' ? raw.integrationID : null
    if (!id || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      skipped.push('an entry without a usable integration id')
      continue
    }
    if (raw.active !== true) continue // inactive accounts of an integration
    if (raw.value?.type !== 'key' || typeof raw.value.key !== 'string' || raw.value.key.length === 0) {
      skipped.push(`${id} (not an API key)`)
      continue
    }
    auth[id] = { type: 'api', key: raw.value.key }
  }
  return { auth, skipped }
}

/** Is this command an OpenCode 2.x CLI? (2.x prints "opencode v2.3.0"; 1.x prints "1.18.21".) */
export async function isOpencode2(command: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(command, ['--version'], { timeout: 15_000 })
    return /\bv?2\.\d+\.\d+/.test(stdout) && !/^1\./.test(stdout.trim())
  } catch {
    return false
  }
}

/** Where an OpenCode 2.x CLI may be: the env override, PATH, then the macOS app bundle. */
export function opencode2Candidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const list = [env.ARENA_OPENCODE2_BIN, 'opencode']
  if (platform === 'darwin') list.push('/Applications/OpenCode.app/Contents/Resources/opencode-cli')
  return list.filter((c): c is string => typeof c === 'string' && c.length > 0)
}

/**
 * Write `<dataHome>/opencode/auth.json` (owner-only) from the first OpenCode 2.x CLI found.
 * Returns the file and what was skipped, or null when there is no 2.x CLI or no API key.
 */
export async function bridgeCredentials(opts: {
  dataHome: string
  candidates: string[]
  exportFn?: (command: string) => Promise<string>
}): Promise<{ authFile: string; integrations: string[]; skipped: string[] } | null> {
  const exportFn =
    opts.exportFn ??
    (async (command: string) => (await execFileAsync(command, ['auth', 'export'], { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout)
  for (const command of opts.candidates) {
    if (command.includes('/') && !existsSync(command)) continue
    if (!opts.exportFn && !(await isOpencode2(command))) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(await exportFn(command))
    } catch {
      continue
    }
    const { auth, skipped } = toV1Auth(parsed)
    if (Object.keys(auth).length === 0) return null
    const authFile = join(opts.dataHome, 'opencode', 'auth.json')
    mkdirSync(dirname(authFile), { recursive: true, mode: 0o700 })
    // Write then rename, so a reader never sees half a file; 0600 from the first byte.
    const temp = `${authFile}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(auth, null, 2), { mode: 0o600 })
    renameSync(temp, authFile)
    chmodSync(authFile, 0o600)
    return { authFile, integrations: Object.keys(auth), skipped }
  }
  return null
}
