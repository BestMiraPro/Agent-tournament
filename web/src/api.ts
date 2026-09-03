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
  workspaceRoot: string | null
  authFile: string | null
}

export const createRunFull = (spec: FullRunSpec): Promise<{ runId: string; warnings?: string[] }> =>
  fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  }).then(json)

export const getRun = (runId: string): Promise<RunSnapshot> =>
  fetch(`/api/runs/${runId}`).then(json)

export const getAgentDetail = (runId: string, agentId: string): Promise<AgentDetail> =>
  fetch(`/api/runs/${runId}/agents/${agentId}`).then(json)

export interface RoundStats {
  idx: number
  goalMd: string
  costUsd: number
  fitness: { mean: number; min: number; max: number }
  modelShare: { modelId: string; count: number }[]
  diversity: number
}

export const getRoundStats = (runId: string): Promise<RoundStats[]> =>
  fetch(`/api/runs/${runId}/rounds`).then(json)

export const deleteRun = (runId: string): Promise<{ stopped: boolean }> =>
  fetch(`/api/runs/${runId}`, { method: 'DELETE' }).then(json)

export const startRound = (runId: string, goalMd: string): Promise<unknown> =>
  fetch(`/api/runs/${runId}/rounds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goalMd }),
  }).then(json)

export const patchConfig = (runId: string, config: unknown): Promise<{ warnings: string[] }> =>
  fetch(`/api/runs/${runId}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  }).then(json)
