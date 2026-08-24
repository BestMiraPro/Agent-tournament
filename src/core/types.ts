export type SubmissionStatus = 'ok' | 'timeout' | 'error' | 'no_submission'
export type GenomeOrigin = 'seed' | 'elite' | 'mutation' | 'clone' | 'crossover' | 'manual'
export type AgentStatus = 'active' | 'retired' | 'culled'
export type RoundStatus =
  | 'pending' | 'preparing' | 'running' | 'collecting'
  | 'judging' | 'evolving' | 'reflecting' | 'complete' | 'failed'
export type JudgeMode = 'single_call' | 'batched_finals'
export type CriteriaSource = 'user' | 'generated'

export interface Genome {
  strategyMd: string
  notesMd: string
  modelId: string
  temperature: number
}

export interface GenomeRow extends Genome {
  id: string
  agentId: string
  roundIdx: number
  parentGenomeId: string | null
  origin: GenomeOrigin
  createdAt: number
}

export interface AgentRow {
  id: string
  runId: string
  label: string
  parentAgentId: string | null
  bornRound: number
  diedRound: number | null
  status: AgentStatus
}

export interface SubmissionRow {
  id: string
  roundId: string
  agentId: string
  genomeId: string
  submissionMd: string | null
  fileManifest: FileEntry[]
  workspacePath: string
  status: SubmissionStatus
  errorText: string | null
  tokensIn: number
  tokensOut: number
  costUsd: number
  durationMs: number
}

export interface FileEntry {
  path: string
  bytes: number
}

export interface ScoreRow {
  roundId: string
  agentId: string
  rank: number
  score: number
  rationaleMd: string
  band: 'elite' | 'top' | 'middle' | 'bottom' | null
}

export interface RosterEntry {
  modelId: string
  count: number
  temperature: number
}

export interface RunConfig {
  populationSize: number
  concurrency: number
  agentTimeoutMs: number
  sandbox: 'docker' | 'local' | 'mock'
  maxContainers: number
  containerMemory: string
  containerCpus: number
  seedDir: string | null
  roster: RosterEntry[]
  judge: {
    modelId: string
    mode: 'auto' | JudgeMode
    singleCallMaxPopulation: number
    batchSize: number
    criteriaMode: 'auto' | 'user'
    submissionCharCap: number
    anonymize: boolean
  }
  reflect: {
    modelId: string
    topK: number
    strategyCharCap: number
    allowModelMutation: boolean
  }
  selection: {
    eliteCount: number
    topPct: number
    bottomPct: number
    crossoverPct: number
  }
  pricing: Record<string, { inPerM: number; outPerM: number }>
}

export const DEFAULT_CONFIG: RunConfig = {
  populationSize: 20,
  concurrency: 8,
  agentTimeoutMs: 600_000,
  sandbox: 'mock',
  maxContainers: 12,
  containerMemory: '512m',
  containerCpus: 1,
  seedDir: null,
  roster: [
    { modelId: 'opencode/muse-spark-1.2-contributor-free', count: 5, temperature: 0.7 },
    { modelId: 'opencode/big-pickle', count: 5, temperature: 0.8 },
    { modelId: 'opencode/nemotron-3.5-lightning-free', count: 5, temperature: 0.9 },
    { modelId: 'wandb/deepseek-ai/DeepSeek-V4-Flash', count: 5, temperature: 0.7 },
  ],
  judge: {
    modelId: 'wandb/zai-org/GLM-5.2',
    mode: 'auto',
    singleCallMaxPopulation: 25,
    batchSize: 5,
    criteriaMode: 'auto',
    submissionCharCap: 6000,
    anonymize: true,
  },
  reflect: {
    modelId: 'wandb/deepseek-ai/DeepSeek-V4-Flash',
    topK: 5,
    strategyCharCap: 2000,
    allowModelMutation: true,
  },
  selection: { eliteCount: 1, topPct: 0.2, bottomPct: 0.2, crossoverPct: 0 },
  pricing: {},
}
