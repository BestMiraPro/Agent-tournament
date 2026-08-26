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
  /** Ceiling on what one agent may leave in its workspace, in bytes. */
  maxWorkspaceBytes: number
  /** Ceiling on how many files one agent may leave behind (inode exhaustion). */
  maxWorkspaceFiles: number
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
  // Container sizing, measured rather than guessed (2026-08-25, reference host): an agent
  // container idles at ~250 MiB and peaks at ~413 MiB under real work, against ~5.2 GiB of
  // free Docker headroom. '512m' left almost no margin over the loaded figure and would
  // OOM-kill agents mid-round — which surfaces as an agent failure rather than the
  // infrastructure failure it is — so '1g' is the cap. Four 1g containers is what that
  // headroom safely allows: the capacity preflight commits at most 80% of free memory, so
  // 5.2 GiB free funds 4 containers and refuses a 5th.
  //
  // These two numbers do NOT buy workspace isolation, and it would be wrong to read them
  // that way. maxContainers 4 against populationSize 20 is FIVE agents per container, and
  // a shard is a single bind mount — every co-tenant can write into the others'
  // workspaces. So under stock defaults DockerSandbox.isolatedWorkspace() is false for
  // every agent, no capture is ever sealed, and no submission is ever certified
  // verified-intact. Tamper *detection* still works (a positive finding needs only the
  // round-wide barrier, not a sealed capture), and that is the whole of the protection
  // these defaults provide: interference is recorded after the fact, not prevented.
  //
  // One container per agent is what makes "this is the agent's own unmodified work" a
  // certifiable claim, and it costs maxContainers >= populationSize: at 20 x 1g that is
  // 20 GiB committed, which the 80% headroom rule turns into 25 GiB of free Docker memory,
  // plus 20 host CPUs for the containerCpus: 1 check. That is ~5x the reference host.
  // Raising maxContainers alone does not achieve it — the preflight would simply refuse
  // the run on any host that cannot fund it.
  maxContainers: 4,
  containerMemory: '1g',
  containerCpus: 1,
  maxWorkspaceBytes: 52_428_800,
  maxWorkspaceFiles: 2000,
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
