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

export const getRun = (runId: string): Promise<RunSnapshot> =>
  fetch(`/api/runs/${runId}`).then(json)

export const startRound = (runId: string, goalMd: string): Promise<unknown> =>
  fetch(`/api/runs/${runId}/rounds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goalMd }),
  }).then(json)
