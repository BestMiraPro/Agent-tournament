import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SearchKeys } from './search.js'

/**
 * Where the search keys come from: the app's environment, else the repository folder's `.env`
 * (gitignored, and the file `docker compose` reads too). Only these two names are read from it.
 * Read per run and per status request, so a key added to `.env` applies to the next run.
 */

export const WEB_KEY_ENV = ['LANGSEARCH_API_KEY', 'EXA_API_KEY'] as const

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m || !(WEB_KEY_ENV as readonly string[]).includes(m[1]!)) continue
    let value = m[2]!.trim()
    const quoted = /^(["'])(.*?)\1/.exec(value)
    value = quoted ? quoted[2]! : value.replace(/\s+#.*$/, '')
    out[m[1]!] = value
  }
  return out
}

export function readWebSearchKeys(opts: { env?: NodeJS.ProcessEnv; envFile?: string } = {}): SearchKeys {
  const env = opts.env ?? process.env
  let file: Record<string, string> = {}
  try {
    file = parseEnvFile(readFileSync(opts.envFile ?? join(process.cwd(), '.env'), 'utf8'))
  } catch {
    file = {}
  }
  const pick = (name: (typeof WEB_KEY_ENV)[number]) => {
    const value = (env[name]?.trim() || file[name]?.trim()) ?? ''
    return value === '' ? null : value
  }
  return { langsearch: pick('LANGSEARCH_API_KEY'), exa: pick('EXA_API_KEY') }
}

export interface WebSearchStatus {
  primary: { id: 'langsearch'; name: 'LangSearch'; configured: boolean }
  fallback: { id: 'exa'; name: 'Exa'; mode: 'keyed' | 'keyless' }
}

/** What the dashboard may know: which provider would answer, never a key. */
export function webSearchStatus(keys: SearchKeys): WebSearchStatus {
  return {
    primary: { id: 'langsearch', name: 'LangSearch', configured: keys.langsearch !== null },
    fallback: { id: 'exa', name: 'Exa', mode: keys.exa !== null ? 'keyed' : 'keyless' },
  }
}
