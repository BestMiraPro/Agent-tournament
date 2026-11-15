export interface SnapshotAgent {
  agentId: string
  label: string
  modelId: string
  temperature: number
  strategyMd: string
  bornRound: number
  parentAgentId: string | null
}

/** Mirrors AgentFailure in src/core/failure.ts: why one attempt failed, safe to show. */
export interface AgentFailure {
  message: string
  httpStatus?: number
  code?: string
  ref?: string
}

export interface SnapshotScore {
  agentId: string
  rank: number
  score: number
  band: string | null
  rationaleMd: string
  /** The submission for that round did not succeed, so the rank is not a win. */
  failed: boolean
}

/** Mirrors ActivityItem in src/engine/events.ts: one piece of public agent activity. */
export interface ActivityItem {
  id: string
  runId: string
  roundIdx: number
  agentId: string
  sessionId: string
  observedAt: number
  kind: 'text' | 'tool' | 'file' | 'permission' | 'error'
  status?: 'pending' | 'running' | 'completed' | 'error' | 'waiting'
  summary: string
  output?: string
  truncated?: boolean
  revision: number
}

/** Mirrors StreamHealth in src/server/activity.ts. */
export interface StreamHealth {
  state: 'connected' | 'reconnecting'
  message?: string
  at: number
}

/** Mirrors ActivitySnapshot in src/server/activity.ts. */
export interface ActivitySnapshot {
  revision: number
  roundIdx: number
  agents: Record<string, {
    items: ActivityItem[]
    lastObservedAt: number | null
    truncated: boolean
    status: 'pending' | 'running' | 'done' | 'failed'
    failure: AgentFailure | null
    usageReported: boolean
  }>
  streams: Record<string, StreamHealth>
}

/** Mirrors AppliedCriteria in src/server/state.ts: what a round has on record. */
export interface AppliedCriteria {
  roundIdx: number
  criteriaMd: string | null
  source: 'user' | 'generated'
  status: string
}

/** One container in a docker run's current plan. */
export interface Placement {
  shardIndex: number
  agentIds: string[]
  occupancy: 'single' | 'shared'
}

export type { CapacityInfo } from './lib/placement.js'
import type { CapacityInfo } from './lib/placement.js'

export interface RunSnapshot {
  runId: string
  name: string
  /** A team judged on its shared output, or an evolving tournament; absent on servers from before. */
  workflow?: 'collaboration' | 'tournament'
  lastRoundIdx: number
  goalMd: string | null
  /** Saved creation criteria: the round-1 draft default. */
  initialCriteria: string | null
  /** The latest round's recorded criteria; null before round 1. */
  lastRoundCriteria: AppliedCriteria | null
  agents: SnapshotAgent[]
  scores: SnapshotScore[]
  busy: boolean
  lastError: string | null
  sandbox: string
  roster: { modelId: string; count: number; temperature: number }[]
  capacity: { committed: number; maxContainers: number } | null
  warnings: string[]
  /** Docker runs with a live plan: each container and its agents. Null otherwise. */
  placement?: Placement[] | null
  /** Live activity this server holds for the run; null when it holds none (e.g. after a restart). */
  activity?: ActivitySnapshot | null
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
      /** false: no usage was observed (lost response); null: recorded before tracking. */
      usageKnown: boolean | null
    } | null
  }[]
}

/** One file of a collaboration round's sealed output. */
export interface TeamFile {
  path: string
  bytes: number
  sha256: string | null
  binary: boolean
  stored: boolean
}

/** Mirrors GET /api/runs/:runId/rounds/:idx/output. */
export interface TeamOutput {
  roundId: string
  status: string
  errorText: string | null
  digest: string
  sealed: boolean
  hashesComplete: boolean
  fileCount: number
  totalBytes: number
  files: TeamFile[]
  contributions: Record<string, { label: string; files: string[]; posts: number; toolCalls: number }>
  capturedAt: number
}

export interface ChannelMessage {
  seq: number
  author: string
  agentId: string | null
  target: string | null
  postedAt: string
  body: string
}

export const getRoundOutput = (runId: string, idx: number): Promise<TeamOutput> =>
  fetch(`/api/runs/${runId}/rounds/${idx}/output`).then(json)

export const getRoundOutputFile = (runId: string, idx: number, path: string): Promise<TeamFile & { content: string | null }> =>
  fetch(`/api/runs/${runId}/rounds/${idx}/output/file?path=${encodeURIComponent(path)}`).then(json)

export const getRoundChannel = (runId: string, idx: number): Promise<{ messages: ChannelMessage[] }> =>
  fetch(`/api/runs/${runId}/rounds/${idx}/channel`).then(json)

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
  workflow: 'collaboration' | 'tournament'
  roster: { modelId: string; count: number; temperature: number }[]
  // WHY optional + never-null: the server judge/reflect partials are
  // optional-only (unlike workspaceRoot's z.nullable) — an explicit null
  // 400s, so App omits blank model ids (undefined drops out of the JSON
  // body) and the server partials default-fill them.
  judge: { modelId?: string; mode: 'auto' | 'single_call' | 'batched_finals' }
  reflect: { modelId?: string }
  workspaceRoot: string | null
  authFile: string | null
  contextDir: string | null
  seedStrategiesDir: string | null
  criteria: string | null
  selection: { eliteCount: number; topPct: number; bottomPct: number; crossoverPct: number }
  concurrency: number
  // Docker only; the server defaults any that are omitted.
  maxContainers?: number
  containerMemory?: string
  containerCpus?: number
  isolation?: 'protected' | 'shared'
  pricing: Record<string, { inPerM: number; outPerM: number; cacheReadPerM: number; cacheWritePerM: number }>
  /** Local and docker runs only: connectors the run's agents get, and the write tools it opts into. */
  connectors?: { id: string; writeTools: string[] }[]
}

/** Docker capacity and this app's reservations; rejects when the server cannot read Docker. */
export const getCapacity = (): Promise<CapacityInfo> => fetch('/api/capacity').then(json)

export const createRunFull = (spec: FullRunSpec): Promise<{ runId: string; warnings?: string[] }> =>
  fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  }).then(json)

export const getRun = (runId: string): Promise<RunSnapshot> =>
  fetch(`/api/runs/${runId}`).then(json)

// Minimal RunConfig mirror — only the fields compare.ts diffs. Permissive on
// purpose: the export endpoint serves the full server RunConfig; we only type
// what CompareRuns reads. Update alongside src/core/types.ts if the diff set
// grows.
export interface RunConfig {
  sandbox: string
  concurrency: number
  roster: { modelId: string; count: number; temperature: number }[]
  judge: { modelId: string; mode: string }
  reflect: { modelId: string }
  selection: { topPct: number; bottomPct: number; eliteCount: number; crossoverPct: number }
  budget: { maxRunTokens: number; maxRoundTokens: number; maxAgentTokens: number }
}

// Mirrors buildJsonDump in src/server/export.ts — only the fields CompareRuns
// renders. The endpoint returns more (full RunRow/RoundRow/AgentRow/GenomeRow
// + submission joins); this permissive shape is what the diff consumes.
export interface RunExport {
  run: { id: string; name: string; createdAt: number; status: string }
  config: RunConfig
  rounds: {
    idx: number
    goalMd: string
    costUsd: number
    entries: { agentId: string; label: string; modelId: string; score: number; rank: number }[]
  }[]
  agents: { id: string; label: string }[]
  genomes: { id: string; agentId: string; roundIdx: number; modelId: string }[]
}

export const getExport = (runId: string): Promise<RunExport> =>
  fetch(`/api/runs/${runId}/export?format=json`).then(json)

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

/**
 * The provider catalogue, cached for the session.
 *
 * Two components fetch it independently and each refetched on every mount, so
 * opening the round-detail panel repeatedly re-requested a list that only changes
 * when the operator authenticates a new provider. In-flight calls share one promise
 * so concurrent mounts collapse to a single request.
 *
 * Failures are never cached — a models endpoint that was briefly down would
 * otherwise leave the pickers empty for the rest of the session.
 */
let modelsCache: string[] | null = null
let modelsInFlight: Promise<string[]> | null = null

export const clearModelsCache = (): void => {
  modelsCache = null
  modelsInFlight = null
}

// Throws the server's 502 message verbatim (via the shared serverError
// unwrap); callers treat any failure as "no known-models list".
export const listModels = async (): Promise<string[]> => {
  if (modelsCache) return modelsCache
  if (modelsInFlight) return modelsInFlight

  modelsInFlight = (async () => {
    let body: { models: string[] }
    try {
      body = (await fetch('/api/models').then(json)) as { models: string[] }
    } catch (e) {
      throw new Error(serverError(e))
    }
    modelsCache = body.models
    return body.models
  })().finally(() => {
    modelsInFlight = null
  })

  return modelsInFlight
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
  judgeMode: string
  /**
   * 'judge' = scores came from the judge (0-100, comparable across rounds).
   * 'rank'  = batched mode derived them from final ordering, so they are NOT
   *           comparable with judge scores. The chart marks these rounds.
   */
  scoreScale: 'judge' | 'rank'
  /** Collaboration rounds: the one team score; null for tournament rounds. */
  team?: { score: number; status: string } | null
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
      /** false: no usage was observed (lost response); null: recorded before tracking. */
      usageKnown: boolean | null
    } | null
  }[]
  /** Collaboration rounds: the team's score and the judge's rationale; null otherwise. */
  team?: { score: number; rationaleMd: string; status: string } | null
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

export interface RejudgeEntry {
  agentId: string
  label: string
  oldScore: number
  oldRank: number
  newScore: number
  newRank: number
  newRationaleMd: string
  rankChanged: boolean
}

export interface RejudgeResult {
  entries: RejudgeEntry[]
  metaDigest: string
  mode: string
  /** The new grading record, labelled a preview: it is not stored against the round. */
  preview?: JudgingEnvelope
}

/** Mirrors SafetyFinding in src/judge/audit.ts. */
export interface SafetyFinding {
  category: string
  severity: string
  summary: string
  evidenceIds: string[]
}

/** Mirrors SafetyReview: a behavioural review, separate from the score. */
export interface SafetyReview {
  status: string
  findings: SafetyFinding[]
  limitations: string[]
}

export interface CriterionAssessment {
  criterion: string
  assessment: string
  evidenceIds: string[]
}

/** Mirrors ScoringAudit: what the grader assessed and how the number was derived. */
export interface ScoringAudit {
  criteria: CriterionAssessment[]
  scoreDerivation: string
  limitations: string[]
  safety: SafetyReview
  stages?: {
    batch: { rank: number; of: number } | null
    finals: { rank: number; of: number } | null
    position: number
    of: number
    formula: string
  }
}

/** Mirrors AuditEvidence in src/engine/audit.ts: one observed, bounded public record. */
export interface AuditEvidenceItem {
  id: string
  agentId: string | null
  kind: string
  outcome?: string
  summary: string
  detail?: string
  observedAt: number
  source: string
}

export interface JudgingCall {
  stage: string
  purpose: string
  modelId: string
  refs: Record<string, string>
  prompt: string
  /** The model's reasoning trace; null when none arrived, or for envelopes sealed before it was recorded. */
  reasoning: string | null
  response: unknown
  repaired: boolean
  error: string | null
}

/** Mirrors JudgingAuditEnvelope: the round's grading record. */
export interface JudgingEnvelope {
  schemaVersion: number
  kind: string
  createdAt: number
  evaluator: { modelId: string; runtime: string }
  mode: string
  rubric: { criteriaMd: string; source: string; digest: string }
  evidence: { status: string; digest: string | null }
  promptVersion: string
  calls: JudgingCall[]
  agents: Record<string, ScoringAudit>
}

export interface AgentCoverage {
  records: number
  dropped: number
  truncated: number
  capture: { sealed: boolean; verified: boolean; tampered: boolean } | null
}

/** GET /api/runs/:runId/rounds/:idx/judging: the grading record and the evidence it cites. */
export interface RoundJudging {
  judging: JudgingEnvelope | null
  audit: {
    status: string
    frozen: {
      digest: string
      streamGaps: number
      agents: Record<string, AgentCoverage>
      provenance: { sandbox: string; isolation: string | null; toolchainId: string | null } | null
    } | null
    records: AuditEvidenceItem[]
    late: AuditEvidenceItem[]
    digestMatches: boolean | null
  }
}

export const getRoundJudging = (runId: string, idx: number): Promise<RoundJudging> =>
  fetch(`/api/runs/${runId}/rounds/${idx}/judging`).then(json)

export const rejudge = (runId: string, idx: number, judgeModelId: string): Promise<RejudgeResult> =>
  fetch(`/api/runs/${runId}/rounds/${idx}/rejudge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ judgeModelId }),
  }).then(json)

/** Mirrors connectorView in src/server/connectors-api.ts: a connector, never its credential values. */
export interface ConnectorToolRow {
  name: string
  description: string
  readOnlyHint: boolean | null
  /** read: exposed unless switched off; write: needs a permit and a per-run opt-in; locked: never exposed. */
  classification: 'read' | 'write' | 'locked'
}

export interface ConnectorInfo {
  id: string
  title: string
  kind: 'github' | 'slack' | 'gmail' | 'custom'
  builtin: false
  origin: { type: 'preset' | 'custom' } | { type: 'imported'; source: string; name: string }
  transport:
    | { type: 'stdio'; command: string; args: string[]; envNames: string[]; secretEnvNames: string[] }
    | { type: 'http'; url: string; headerNames: string[]; secretHeaderNames: string[] }
    | { type: 'slack' | 'gmail' }
  auth: { type: 'none' | 'oauth-google' | 'oauth-mcp' } | { type: 'token'; source: 'manual' | 'gh-cli'; env?: string }
  secretsSet: string[]
  connected: boolean
  locked: boolean
  readAllowlist: string[] | null
  policy: { disabledTools: string[]; writeTools: string[] }
  tools: ConnectorToolRow[] | null
  toolsCheckedAt: number | null
}

export interface BuiltinConnectorInfo {
  id: string
  title: string
  description: string
  builtin: true
  readOnly: true
}

export interface ConnectorList {
  store: boolean
  connectors: ConnectorInfo[]
  builtins: BuiltinConnectorInfo[]
}

export type ConnectorPreset =
  | { preset: 'github'; id?: string; title?: string; mode: 'remote' | 'local'; url?: string; command?: string; tokenSource: 'manual' | 'gh-cli'; token?: string }
  | { preset: 'slack'; id?: string; title?: string; token: string }
  | { preset: 'gmail'; id?: string; title?: string; clientId: string; clientSecret: string }
  | { preset: 'remote'; id: string; title?: string; url: string; headers?: Record<string, string>; bearerToken?: string }
  | { preset: 'local'; id: string; title?: string; command: string; args?: string[]; env?: Record<string, string> }

export interface ImportableServer {
  key: string
  name: string
  source: string
  from: string
  suggestedId: string
  imported: boolean
  transport: { type: 'stdio'; command: string; args: string[]; env: Record<string, string> } | { type: 'http'; url: string; headers: Record<string, string> }
}

const sendJson = (method: string, url: string, body?: unknown) =>
  fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(json)

export const listConnectors = (): Promise<ConnectorList> => fetch('/api/connectors').then(json)
export const addConnector = (preset: ConnectorPreset): Promise<{ connector: ConnectorInfo }> => sendJson('POST', '/api/connectors', preset)
export const updateConnector = (
  id: string,
  patch: { title?: string; policy?: Partial<ConnectorInfo['policy']>; token?: string; clientId?: string; clientSecret?: string },
): Promise<{ connector: ConnectorInfo }> => sendJson('PATCH', `/api/connectors/${encodeURIComponent(id)}`, patch)
export const removeConnector = (id: string): Promise<{ ok: true }> => sendJson('DELETE', `/api/connectors/${encodeURIComponent(id)}`)
export const testConnector = (id: string): Promise<{ connector?: ConnectorInfo; tools?: ConnectorToolRow[] }> =>
  sendJson('POST', `/api/connectors/${encodeURIComponent(id)}/test`, {})
export const listImportable = (): Promise<{ servers: ImportableServer[] }> => fetch('/api/connectors/import').then(json)
export const importConnector = (key: string, id?: string): Promise<{ connector: ConnectorInfo }> =>
  sendJson('POST', '/api/connectors/import', { key, ...(id ? { id } : {}) })
export const startConnectorSignIn = (id: string): Promise<{ authorizationUrl?: string; connected?: boolean }> =>
  sendJson('POST', `/api/connectors/${encodeURIComponent(id)}/oauth/start`, {})
