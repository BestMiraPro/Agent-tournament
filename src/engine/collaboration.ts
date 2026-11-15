import { errorTextFor } from '../core/failure.js'
import { serializeCompetitorProfile, teamProfileName } from '../core/genome.js'
import type { AgentRow, Genome, GenomeRow, RunConfig, SubmissionStatus } from '../core/types.js'
import type { Repos } from '../db/repos.js'
import type { Reflector } from '../evolution/reflect.js'
import { buildJudgingEnvelope, evidenceFromAudit, type JudgeCallRecord, type JudgeRecorder } from '../judge/audit.js'
import type { Judge } from '../judge/judge.js'
import type { AgentRunner, AgentRunResult, TeamContext } from '../runtime/agent-runner.js'
import { runPool, type PoolResult } from '../runtime/pool.js'
import type { AgentHandle, Sandbox } from '../runtime/sandbox.js'
import { memberDir } from '../runtime/team-prompt.js'
import type { AuditCollector } from './audit.js'
import type { BudgetBreach, BudgetTracker } from './budget.js'
import type { QuiesceStatus } from './capture.js'
import {
  CHANNEL_FILE,
  CHANNEL_PREAMBLE,
  ChannelTail,
  MAX_STORED_BODY_CHARS,
  POST_HELPER_PATH,
  POST_HELPER_SOURCE,
  roundLine,
  type ChannelLimits,
  type RecordedEntry,
} from './channel.js'
import type { EngineEvent } from './events.js'
import { captureTeamOutput, teamContributions } from './team-capture.js'

/** Characters of a channel entry carried by the live `channel.message` event. */
const MAX_EVENT_BODY_CHARS = 4000

/** Writes a round's sealed output where the grader can open it with its read-only tools. */
export interface SealedArtifactWriter {
  /** Returns the folder holding the sealed `output/`, as the grader sees it. */
  write(roundId: string, files: readonly { path: string; content: string }[]): Promise<string>
}

/** One agent's attempt as the engine runs it, shared with tournaments (see the driver). */
export interface AgentAttempt {
  runId: string
  roundIdx: number
  config: RunConfig
  budget: BudgetTracker
  agent: AgentRow
  genome: GenomeRow
  goalMd: string
  handle: AgentHandle | undefined
  prepError: string | undefined
  team?: TeamContext
  /** Just before the runner is called. */
  onDispatched?: (agentId: string) => void
  /** The moment the runner returned or threw, before the agent is quiesced. */
  onEnded?: (agentId: string) => void
  /** After the agent was quiesced. */
  afterStop?: (handle: AgentHandle, stopped: QuiesceStatus) => Promise<void>
}

export interface CollaborationHost {
  repos: Repos
  sandbox: Sandbox
  runner: AgentRunner
  judge: Judge
  reflector: Reflector
  config: RunConfig
  budget: BudgetTracker
  audit?: AuditCollector
  channelLimits?: Partial<ChannelLimits>
  sealedArtifacts?: SealedArtifactWriter
  /** Folders outside the workspace each member's profile may read. */
  readableDirs: string[]
  /** Seed sizes of each run's team workspace, taken when it was created. */
  teamSeeds: Map<string, Map<string, number>>
  emit: (event: EngineEvent) => void
  aborted: () => boolean
  releaseWorkers: () => Promise<void>
  attempt: (a: AgentAttempt) => Promise<AgentRunResult>
}

export interface CollaborationRound {
  runId: string
  roundId: string
  roundIdx: number
  goalMd: string
  submittedCriteria: string | null
  prepared: { agent: AgentRow; genome: GenomeRow }[]
}

/**
 * One collaboration round, after the driver's preflight has created the round row.
 *
 * The team works in one shared workspace that carries over between rounds, talks through
 * CHANNEL.md, and is judged once on the output folder it built. Nobody is selected, cloned or
 * culled; every member's strategy is rewritten from the team's result and its own part in it.
 * Failure handling, abort gates and the budget rules are the tournament's (see the driver).
 */
export async function runCollaborationRound(
  host: CollaborationHost,
  r: CollaborationRound,
): Promise<{ metaDigest: string; budgetBreach: BudgetBreach | null }> {
  const { repos, sandbox, runner, config, budget } = host
  const { runId, roundId, roundIdx, goalMd, prepared } = r
  const setStatus = (status: 'running' | 'collecting' | 'judging' | 'reflecting') => {
    repos.rounds.setStatus(roundId, status)
    host.emit({ type: 'round.status', runId, roundIdx, status })
  }

  // PREPARE (the driver has set the status and resolved genomes): one shared workspace,
  // created and seeded once, kept across rounds.
  const agentIds = prepared.map((p) => p.agent.id)
  const team = await sandbox.provisionTeam!(runId, agentIds, { seedDir: config.seedDir ?? undefined })
  const workspace = team.handles.get(agentIds[0]!)!
  if (team.created && config.seedDir) {
    host.teamSeeds.set(runId, new Map((await sandbox.listFiles(workspace)).map((f) => [f.path, f.bytes])))
  }
  await sandbox.writeFile(workspace, 'GOAL.md', goalMd)
  await sandbox.writeFile(workspace, POST_HELPER_PATH, POST_HELPER_SOURCE)
  for (const p of prepared) {
    await sandbox.writeFile(workspace, `${memberDir(p.agent.label)}/NOTES.md`, p.genome.notesMd)
    await sandbox.writeFile(
      workspace,
      `.opencode/agents/${teamProfileName(p.agent.label)}.md`,
      serializeCompetitorProfile(p.genome, { label: p.agent.label, readableDirs: host.readableDirs }),
    )
  }
  // Earlier rounds' entries stay in the file for the team to read; they are not news.
  const before = await sandbox.readFile(workspace, CHANNEL_FILE)
  await sandbox.writeFile(workspace, CHANNEL_FILE, (before ?? CHANNEL_PREAMBLE) + roundLine(roundIdx))

  // RUN: everybody at once — a team that cannot work simultaneously cannot talk.
  setStatus('running')
  const members = prepared.map((p) => ({ agentId: p.agent.id, label: p.agent.label }))
  const entries: RecordedEntry[] = []
  const live = new Set<string>()
  const dispatched = new Set<string>()
  const tail = new ChannelTail({
    read: () => sandbox.readFile(workspace, CHANNEL_FILE),
    members,
    isLive: (agentId) => live.has(agentId),
    deliver: async (agentId, text) => (runner.send ? runner.send(team.handles.get(agentId)!, text) : false),
    onEntry: (e) => {
      entries.push(e)
      const body = e.body.length > MAX_STORED_BODY_CHARS ? `${e.body.slice(0, MAX_STORED_BODY_CHARS)}\n[…]` : e.body
      repos.channel.append({ runId, roundId, seq: e.seq, author: e.author, agentId: e.agentId, target: e.target, postedAt: e.postedAt, body })
      host.emit({
        type: 'channel.message', runId, roundIdx, seq: e.seq, author: e.author, agentId: e.agentId, target: e.target, postedAt: e.postedAt,
        body: e.body.length > MAX_EVENT_BODY_CHARS ? `${e.body.slice(0, MAX_EVENT_BODY_CHARS)}…` : e.body,
      })
    },
    onDelivered: (agentId, seqs) => repos.channel.markDelivered(roundId, seqs, agentId),
    limits: host.channelLimits,
  })
  tail.prime(before)
  tail.start()
  // The command as the agent runs it: the helper sits in the workspace, at the agent's path for it.
  const postCommand = `node "${workspace.workspacePath.replace(/[\\/]+$/, '')}/${POST_HELPER_PATH}"`
  const quiesced = new Map<string, QuiesceStatus>()
  let runResults: PoolResult<AgentRunResult>[]
  try {
    runResults = await runPool(prepared, Math.max(1, prepared.length), (p) => host.attempt({
      runId, roundIdx, config, budget, agent: p.agent, genome: p.genome, goalMd,
      handle: team.handles.get(p.agent.id), prepError: undefined,
      team: { label: p.agent.label, teammates: members.filter((m) => m.agentId !== p.agent.id).map((m) => m.label), postCommand },
      onDispatched: (id) => { dispatched.add(id); live.add(id) },
      onEnded: (id) => { live.delete(id) },
      afterStop: async (h, stopped) => { quiesced.set(h.agentId, stopped) },
    }), { shouldStop: host.aborted })
  } finally {
    // The barrier: every entry written before it is recorded; none is delivered any more.
    await tail.drain()
  }
  const budgetBreach = budget.check()

  // COLLECT: the team's output folder, once, with nothing left that could write to it.
  setStatus('collecting')
  const executionStopped = [...dispatched].every((id) => quiesced.get(id) === 'stopped')
  const n = Math.max(1, prepared.length)
  const capture = await captureTeamOutput(sandbox, workspace, {
    executionStopped,
    quota: { maxBytes: config.maxWorkspaceBytes * n, maxFiles: config.maxWorkspaceFiles * n },
    seeded: host.teamSeeds.get(runId),
  })
  repos.teamOutputs.insert({
    roundId, runId, status: capture.status, errorText: capture.errorText, digest: capture.digest, sealed: capture.sealed,
    hashesComplete: capture.hashesComplete, fileCount: capture.fileCount, totalBytes: capture.totalBytes, files: capture.files,
    channelMd: capture.channelMd, channelSha256: capture.channelSha256, contributions: {}, capturedAt: capture.capturedAt,
  }, capture.contents)
  repos.events.append({
    runId, roundId, agentId: null, type: 'team.captured',
    payload: { digest: capture.digest, sealed: capture.sealed, hashesComplete: capture.hashesComplete, status: capture.status, files: capture.fileCount },
  })
  for (const [i, p] of prepared.entries()) {
    const res = runResults[i]!
    const status: SubmissionStatus = !res.ok ? 'error' : res.value.status
    // The team snapshot stands in for each member's capture in the frozen audit: one seal,
    // taken after the barrier, so nothing can have changed it since (verified = sealed).
    repos.events.append({
      runId, roundId, agentId: p.agent.id, type: 'submission.captured',
      payload: {
        sealed: capture.sealed, verified: capture.sealed && capture.hashesComplete, tampered: false,
        hashesComplete: capture.hashesComplete, capturedAt: capture.capturedAt,
        quiesce: quiesced.get(p.agent.id) ?? 'unsupported', team: true,
      },
    })
    repos.submissions.create({
      roundId, agentId: p.agent.id, genomeId: p.genome.id,
      submissionMd: null, fileManifest: [], workspacePath: workspace.workspacePath, status,
      errorText: !res.ok ? errorTextFor(res.error) : res.value.errorText,
      tokensIn: res.ok ? res.value.tokensIn : 0,
      tokensOut: res.ok ? res.value.tokensOut : 0,
      tokensCacheRead: res.ok ? res.value.tokensCacheRead : 0,
      tokensCacheWrite: res.ok ? res.value.tokensCacheWrite : 0,
      costUsd: res.ok ? res.value.costUsd : 0,
      durationMs: res.ok ? res.value.durationMs : 0,
      usageKnown: res.ok ? res.value.usageKnown !== false : false,
    })
  }

  // JUDGE
  if (host.aborted()) throw new Error('round aborted by user')
  const frozenAudit = host.audit?.freeze(runId, roundId, agentIds) ?? null
  const contributions = teamContributions(members, frozenAudit?.records ?? [], entries, workspace.workspacePath)
  repos.teamOutputs.setContributions(roundId, contributions)
  // Workers go once the evidence is frozen; judging reads only the sealed snapshot.
  await host.releaseWorkers()
  setStatus('judging')
  const rowNow = repos.rounds.get(roundId)
  const effective = rowNow?.criteriaSource === 'user' ? rowNow.criteriaMd : r.submittedCriteria
  const judgeCalls: JudgeCallRecord[] = []
  const recorder: JudgeRecorder = (c) => { judgeCalls.push(c) }
  const { criteriaMd, source } = await host.judge.resolveCriteria(goalMd, effective, recorder)
  repos.rounds.setCriteria(roundId, criteriaMd, source)
  const stored = [...capture.contents].map(([path, content]) => ({ path, content }))
  let artifactPath: string | null = null
  if (capture.status === 'ok' && host.sealedArtifacts) {
    try {
      artifactPath = await host.sealedArtifacts.write(roundId, stored)
    } catch {
      // The grader still sees the README and the text inline.
      artifactPath = null
    }
  }
  const judged = await host.judge.scoreTeam(goalMd, criteriaMd, {
    status: capture.status,
    reason: capture.errorText,
    readmeMd: capture.readmeMd,
    files: capture.files.map((f) => ({ path: f.path, bytes: f.bytes, binary: f.binary })),
    texts: stored,
    artifactPath,
    members: prepared.map((p) => ({ agentId: p.agent.id, evidence: evidenceFromAudit(frozenAudit, p.agent.id) })),
  }, roundIdx, recorder)
  repos.rounds.setDigest(roundId, judged.metaDigest)
  try {
    repos.judgingAudits.insert({
      roundId,
      payload: buildJudgingEnvelope({
        roundId, kind: 'original', evaluator: host.judge.evaluator(), mode: judged.mode, criteriaMd, criteriaSource: source,
        evidence: { status: frozenAudit ? 'recorded' : 'not_recorded', digest: frozenAudit?.frozen.digest ?? null },
        calls: judgeCalls, agents: judged.audits,
      }),
    })
  } catch {
    // A graded round must not fail because its record could not be written.
  }
  repos.rounds.setJudgeMode(roundId, judged.mode)
  repos.teamScores.insert({ roundId, runId, score: judged.score, rationaleMd: judged.rationaleMd, status: capture.status })
  // Every member's score is the team's, so per-agent history and analytics read it unchanged.
  repos.scores.insertMany(roundId, prepared.map((p) => ({
    roundId, agentId: p.agent.id, rank: 1, score: judged.score, rationaleMd: judged.rationaleMd, band: null,
  })))
  host.emit({
    type: 'round.scored', runId, roundIdx,
    scores: prepared.map((p, i) => ({
      agentId: p.agent.id, rank: 1, score: judged.score,
      failed: !runResults[i]!.ok || (runResults[i] as { value: AgentRunResult }).value.status !== 'ok',
    })),
    team: { score: judged.score, status: capture.status },
  })

  // REFLECT: no selection, no breeding; each member rewrites its own strategy.
  if (host.aborted()) throw new Error('round aborted by user')
  setStatus('reflecting')
  const mutated = new Map<string, Genome>()
  if (budgetBreach === null) {
    const reflected = await runPool(prepared, config.concurrency, async (p) => {
      const mine = contributions[p.agent.id]
      return [p.agent.id, await host.reflector.reflectTeam({
        ownStrategy: p.genome.strategyMd,
        ownNotes: p.genome.notesMd,
        teamScore: judged.score,
        teamSize: prepared.length,
        teamRationale: judged.rationaleMd,
        metaDigest: judged.metaDigest,
        ownPosts: entries.filter((e) => e.agentId === p.agent.id).map((e) => e.body),
        ownFiles: mine?.files ?? [],
        ownToolCalls: mine?.toolCalls ?? 0,
        nextGoal: goalMd,
        currentModelId: p.genome.modelId,
        currentTemperature: p.genome.temperature,
      })] as const
    })
    for (const x of reflected) if (x.ok) mutated.set(x.value[0], x.value[1])
  }
  for (const p of prepared) {
    if (repos.genomes.forRound(p.agent.id, roundIdx + 1)) continue
    const next = mutated.get(p.agent.id)
    repos.genomes.create({
      agentId: p.agent.id,
      roundIdx: roundIdx + 1,
      strategyMd: next?.strategyMd ?? p.genome.strategyMd,
      notesMd: next?.notesMd ?? p.genome.notesMd,
      modelId: next?.modelId ?? p.genome.modelId,
      temperature: next?.temperature ?? p.genome.temperature,
      parentGenomeId: p.genome.id,
      // Without a rewrite (a breach, a failed reflection) the strategy carries forward unchanged.
      origin: next ? 'mutation' : 'clone',
    })
  }
  return { metaDigest: judged.metaDigest, budgetBreach }
}
