export interface SnapshotAgent {
  agentId: string
  label: string
  modelId: string
  temperature: number
  strategyMd: string
  bornRound: number
  parentAgentId: string | null
}

export interface SnapshotScore {
  agentId: string
  rank: number
  score: number
  band: string | null
  rationaleMd: string
}

export interface RunSnapshot {
  runId: string
  name: string
  lastRoundIdx: number
  goalMd: string | null
  agents: SnapshotAgent[]
  scores: SnapshotScore[]
  busy: boolean
  lastError: string | null
  sandbox: string
  roster: { modelId: string; count: number; temperature: number }[]
  capacity: { committed: number; maxContainers: number } | null
  warnings: string[]
}

export interface AgentDetail {
  agent: {
    agentId: string
    label: string
    bornRound: number
    diedRound: number | null
    status: string
    parentAgentId: string | null
  }
  lineage: { agentId: string; label: string; bornRound: number }[]
  genomes: {
    roundIdx: number
    strategyMd: string
    notesMd: string
    modelId: string
    temperature: number
    origin: string
  }[]
  history: {
    roundIdx: number
    score: number
    rank: number
    band: string | null
    rationaleMd: string
    submission: {
      status: string
      errorText: string | null
      submissionMd: string | null
      fileManifest: unknown
      costUsd: number
      durationMs: number | null
      tokens: { in: number; out: number; cacheRead: number; cacheWrite: number }
    } | null
  }[]
}

const json = async (res: Response) => {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

// The shared `json` helper throws `"<status> <body>"`; surface the server's error field.
export function serverError(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e)
  try {
    const parsed = JSON.parse(s.replace(/^\d+ /, '')) as { error?: string }
    if (parsed.error) return parsed.error
  } catch {
    /* body is not json; show the raw message */
  }
  return s
}

export const createRun = (name: string, goal: string): Promise<{ runId: string }> =>
  fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, goal }),
  }).then(json)

export interface FullRunSpec {
  name: string
  goal: string
  sandbox: 'mock' | 'local' | 'docker'
  roster: { modelId: string; count: number; temperature: number }[]
  // WHY optional + never-null: the server judge/reflect partials are
  // optional-only (unlike workspaceRoot's z.nullable) — an explicit null
  // 400s, so App omits blank model ids (undefined drops out of the JSON
  // body) and the server partials default-fill them.
  judge: { modelId?: string; mode: 'auto' | 'single_call' | 'batched_finals' }
  reflect: { modelId?: string }
  workspaceRoot: string | null
  authFile: string | null
  criteria: string | null
  selection: { eliteCount: number; topPct: number; bottomPct: number; crossoverPct: number }
  concurrency: number
  pricing: Record<string, { inPerM: number; outPerM: number; cacheReadPerM: number; cacheWritePerM: number }>
}

export const createRunFull = (spec: FullRunSpec): Promise<{ runId: string; warnings?: string[] }> =>
  fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  }).then(json)

export const getRun = (runId: string): Promise<RunSnapshot> =>
  fetch(`/api/runs/${runId}`).then(json)

export interface RunListItem {
  id: string
  name: string
  createdAt: number
  rounds: number
  bestScore: number | null
  costUsd: number
}

export const getRuns = (): Promise<{ runs: RunListItem[] }> =>
  fetch('/api/runs').then(json)

// Throws the server's 502 message verbatim (via the shared serverError
// unwrap); callers treat any failure as "no known-models list".
export const listModels = async (): Promise<string[]> => {
  let body: { models: string[] }
  try {
    body = (await fetch('/api/models').then(json)) as { models: string[] }
  } catch (e) {
    throw new Error(serverError(e))
  }
  return body.models
}

export const getAgentDetail = (runId: string, agentId: string): Promise<AgentDetail> =>
  fetch(`/api/runs/${runId}/agents/${agentId}`).then(json)

export interface RoundStats {
  idx: number
  goalMd: string
  costUsd: number
  fitness: { mean: number; min: number; max: number }
  modelShare: { modelId: string; count: number }[]
  diversity: number
  criteriaMd: string | null
  criteriaSource: 'user' | 'generated'
  metaDigest: string | null
}

export const getRoundStats = (runId: string): Promise<RoundStats[]> =>
  fetch(`/api/runs/${runId}/rounds`).then(json)

// Mirrors GET /api/runs/:runId/rounds/:idx verbatim (spec §3): header fields +
// entries ASC by rank, submission-or-null per entry (same join as agent history).
export interface RoundDetail {
  idx: number
  goalMd: string
  criteriaMd: string | null
  criteriaSource: 'user' | 'generated'
  metaDigest: string | null
  costUsd: number
  status: string
  judgeMode: string
  entries: {
    agentId: string
    label: string
    modelId: string
    score: number
    rank: number
    band: string | null
    rationaleMd: string
    submission: {
      status: string
      errorText: string | null
      submissionMd: string | null
      fileManifest: unknown
      costUsd: number
      durationMs: number | null
      tokens: { in: number; out: number; cacheRead: number; cacheWrite: number }
    } | null
  }[]
}

export const getRoundDetail = (runId: string, idx: number): Promise<RoundDetail> =>
  fetch(`/api/runs/${runId}/rounds/${idx}`).then(json)

export const deleteRun = (runId: string): Promise<{ stopped: boolean }> =>
  fetch(`/api/runs/${runId}`, { method: 'DELETE' }).then(json)

export const startRound = (runId: string, goalMd: string, criteriaMd?: string | null): Promise<unknown> =>
  fetch(`/api/runs/${runId}/rounds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goalMd, criteriaMd: criteriaMd ?? null }),
  }).then(json)

export const patchConfig = (runId: string, config: unknown): Promise<{ warnings: string[] }> =>
  fetch(`/api/runs/${runId}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  }).then(json)

export type AddAgentStrategy =
  | { mode: 'blank' }
  | { mode: 'pasted'; strategyMd: string }
  | { mode: 'clone'; agentId: string }

export interface AddAgentInput {
  modelId: string
  temperature: number
  strategy: AddAgentStrategy
}

export const createAgent = (runId: string, input: AddAgentInput): Promise<{ agentId: string; label: string }> =>
  fetch(`/api/runs/${runId}/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json)

export const retireAgent = (runId: string, agentId: string): Promise<{ retired: boolean }> =>
  fetch(`/api/runs/${runId}/agents/${agentId}`, { method: 'DELETE' }).then(json)

export const overrideCriteria = (runId: string, idx: number, criteriaMd: string): Promise<{ ok: boolean }> =>
  fetch(`/api/runs/${runId}/rounds/${idx}/criteria`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ criteriaMd }),
  }).then(json)

export const abortRound = (runId: string, idx: number): Promise<{ aborted: boolean }> =>
  fetch(`/api/runs/${runId}/rounds/${idx}/abort`, { method: 'POST' }).then(json)
