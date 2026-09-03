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

const json = async (res: Response) => {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
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
