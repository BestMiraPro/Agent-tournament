import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { lockFor } from './presets.js'
import {
  assertConnectorId,
  type ConnectorAuth,
  type ConnectorKind,
  type ConnectorRecord,
  type ConnectorSecrets,
  type ConnectorTransport,
} from './types.js'

const stringMap = z.record(z.string(), z.string())
const transportSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()), env: stringMap, secretEnv: z.array(z.string()) }),
  z.object({ type: z.literal('http'), url: z.string().nullable(), headers: stringMap, secretHeaders: z.array(z.string()) }),
  z.object({ type: z.literal('slack') }),
  z.object({ type: z.literal('gmail') }),
])
const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('token'), source: z.enum(['manual', 'gh-cli']), env: z.string().optional() }),
  z.object({ type: z.literal('oauth-google') }),
  z.object({ type: z.literal('oauth-mcp') }),
])
const recordSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['github', 'slack', 'gmail', 'custom']),
  origin: z.union([
    z.object({ type: z.literal('preset') }),
    z.object({ type: z.literal('custom') }),
    z.object({ type: z.literal('imported'), source: z.string(), name: z.string() }),
  ]),
  transport: transportSchema,
  auth: authSchema,
  policy: z.object({ disabledTools: z.array(z.string()), writeTools: z.array(z.string()) }),
  tools: z.array(z.object({ name: z.string(), description: z.string(), readOnlyHint: z.boolean().nullable() })).nullable(),
  toolsCheckedAt: z.number().nullable(),
  createdAt: z.number(),
})
const listSchema = z.object({ version: z.literal(1), connectors: z.array(recordSchema) })
const secretsSchema = z.object({
  version: z.literal(1),
  connectors: z.record(z.string(), z.object({
    token: z.string().optional(),
    env: stringMap.optional(),
    args: stringMap.optional(),
    headers: stringMap.optional(),
    url: z.string().optional(),
    google: z.object({ clientId: z.string(), clientSecret: z.string(), refreshToken: z.string().optional(), scope: z.string().optional() }).optional(),
    mcpOauth: z.object({
      clientInformation: z.record(z.string(), z.unknown()).optional(),
      tokens: z.record(z.string(), z.unknown()).optional(),
      codeVerifier: z.string().optional(),
      discovery: z.record(z.string(), z.unknown()).optional(),
    }).optional(),
  })),
})

const LIST_FILE = 'connectors.json'
const SECRETS_FILE = 'secrets.json'

export function newConnectorRecord(
  fields: { id: string; title: string; kind: ConnectorKind; transport: ConnectorTransport; auth: ConnectorAuth; origin?: ConnectorRecord['origin'] },
  now: number,
): ConnectorRecord {
  return {
    id: fields.id,
    title: fields.title,
    kind: fields.kind,
    origin: fields.origin ?? { type: fields.kind === 'custom' ? 'custom' : 'preset' },
    transport: fields.transport,
    auth: fields.auth,
    policy: { disabledTools: [], writeTools: [] },
    tools: null,
    toolsCheckedAt: null,
    createdAt: now,
  }
}

function assertRecord(record: ConnectorRecord): void {
  assertConnectorId(record.id)
  recordSchema.parse(record)
  if (lockFor(record.kind) && record.policy.writeTools.length > 0) {
    throw new Error(`${record.title} is read-only: its write tools cannot be enabled`)
  }
}

/**
 * Connectors and their credentials, on the host only.
 *
 * Two files in one owner-only folder: `connectors.json` (what each connector is, with no credential value) and
 * `secrets.json` (every credential), both written atomically with mode 0600. The folder must sit outside every
 * workspace, context and seed folder; `assertStoreOutside` is what composition checks. Files are read on every call,
 * so the store is always what is on disk; errors name the file, never its content.
 */
export class ConnectorStore {
  readonly dir: string
  private readonly now: () => number

  constructor(dir: string, opts: { now?: () => number } = {}) {
    this.dir = resolve(dir)
    this.now = opts.now ?? Date.now
  }

  list(): ConnectorRecord[] {
    return this.readList().connectors
  }

  get(id: string): ConnectorRecord | null {
    return this.list().find((c) => c.id === id) ?? null
  }

  create(record: ConnectorRecord, secrets: ConnectorSecrets = {}): ConnectorRecord {
    assertRecord(record)
    const list = this.readList()
    if (list.connectors.some((c) => c.id === record.id)) throw new Error(`a connector named "${record.id}" already exists`)
    // Secrets first: a connector must never exist pointing at credentials that were not written.
    this.writeSecrets(record.id, secrets)
    this.write(LIST_FILE, { version: 1, connectors: [...list.connectors, record] })
    return record
  }

  update(id: string, change: (current: ConnectorRecord) => ConnectorRecord): ConnectorRecord {
    const list = this.readList()
    const index = list.connectors.findIndex((c) => c.id === id)
    if (index < 0) throw new Error(`no connector named "${id}"`)
    const next = change(list.connectors[index]!)
    if (next.id !== id) throw new Error('a connector id cannot change')
    assertRecord(next)
    list.connectors[index] = next
    this.write(LIST_FILE, list)
    return next
  }

  remove(id: string): boolean {
    const list = this.readList()
    const kept = list.connectors.filter((c) => c.id !== id)
    if (kept.length === list.connectors.length) return false
    this.write(LIST_FILE, { version: 1, connectors: kept })
    const secrets = this.readSecrets()
    delete secrets.connectors[id]
    this.write(SECRETS_FILE, secrets)
    return true
  }

  secrets(id: string): ConnectorSecrets {
    return this.readSecrets().connectors[id] ?? {}
  }

  setSecrets(id: string, change: (current: ConnectorSecrets) => ConnectorSecrets): void {
    this.writeSecrets(id, change(this.secrets(id)))
  }

  /** Which credentials are set, for display: names only. */
  secretNames(id: string): string[] {
    return Object.entries(this.secrets(id)).filter(([, v]) => v !== undefined).map(([k]) => k)
  }

  /** The current time, for records this store's callers stamp. */
  stamp(): number {
    return this.now()
  }

  private writeSecrets(id: string, value: ConnectorSecrets): void {
    const secrets = this.readSecrets()
    secrets.connectors[id] = value
    this.write(SECRETS_FILE, secrets)
  }

  private readList(): z.infer<typeof listSchema> {
    return this.read(LIST_FILE, listSchema, { version: 1, connectors: [] }) as { version: 1; connectors: ConnectorRecord[] }
  }

  private readSecrets(): { version: 1; connectors: Record<string, ConnectorSecrets> } {
    return this.read(SECRETS_FILE, secretsSchema, { version: 1, connectors: {} })
  }

  private read<T>(name: string, schema: z.ZodType<T>, empty: T): T {
    const path = join(this.dir, name)
    if (!existsSync(path)) return empty
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      throw new Error(`The connector file ${path} is not valid JSON; fix or remove it.`)
    }
    const result = schema.safeParse(parsed)
    if (!result.success) throw new Error(`The connector file ${path} has an unexpected shape; fix or remove it.`)
    return result.data
  }

  private write(name: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const path = join(this.dir, name)
    const temp = join(this.dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, path)
  }
}

/**
 * Refuses a folder that contains the connector store or lies inside it. Workspaces are written by agents, the context
 * folder is mounted into workers, and the seed folder is copied into every workspace: none may reach the secrets.
 */
export function assertStoreOutside(
  storeDir: string,
  folders: { workspaceRoot?: string | null; contextDir?: string | null; seedDir?: string | null },
): void {
  const store = comparable(storeDir)
  const labels: [keyof typeof folders, string][] = [
    ['workspaceRoot', 'workspace root'],
    ['contextDir', 'context folder'],
    ['seedDir', 'seed folder'],
  ]
  for (const [key, label] of labels) {
    const folder = folders[key]
    if (!folder) continue
    const f = comparable(folder)
    if (f === store || store.startsWith(f + sep) || f.startsWith(store + sep)) {
      throw new Error(
        `The ${label} ${folder} overlaps the connector store ${storeDir}, which holds connector credentials. ` +
          'Choose a folder outside it, or start the dashboard with a different --connectors-dir.',
      )
    }
  }
}

function comparable(p: string): string {
  const missing: string[] = []
  let current = resolve(p)
  let real = current
  for (;;) {
    try {
      real = join(realpathSync.native(current), ...missing.reverse())
      break
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        real = resolve(p)
        break
      }
      missing.push(basename(current))
      current = parent
    }
  }
  const trimmed = real.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}
