import { createHash } from 'node:crypto'
import { redactSecrets } from '../core/redact.js'
import type { Repos } from '../db/repos.js'
import type { ActivityItemInput, EngineEvent } from './events.js'

/**
 * Durable, bounded behavioural evidence for one round, below the dashboard.
 *
 * The live activity cache is for watching: it evicts, clears every round and dies with the
 * process. This collector is the record: every event the engine and the OpenCode bridges
 * observe passes through `record`, is reduced to allowlisted public metadata, redacted and
 * written to the `events` table before anything can evict it. At the judging boundary
 * `freeze` settles what is still open, adds capture integrity and coverage losses, and seals
 * the set with a digest; the grader sees that set and nothing later. Events after the freeze
 * are kept as late evidence and never change a set a score was based on.
 *
 * What it cannot see is part of the record (`AUDIT_SENSORS`): a tool call's own summary is
 * observed, the subprocesses a command starts are not. No telemetry is never "safe".
 */

export const AUDIT_SCHEMA_VERSION = 1
export const AUDIT_EVIDENCE_EVENT = 'audit.evidence'
export const AUDIT_LATE_EVENT = 'audit.late'
export const AUDIT_FROZEN_EVENT = 'audit.frozen'

export type AuditSource = 'runtime' | 'policy' | 'provider_stream' | 'capture'
export type AuditKind = 'tool' | 'file' | 'permission' | 'network' | 'integrity' | 'failure' | 'gap'
export type AuditOutcome = 'allowed' | 'denied' | 'completed' | 'failed' | 'unknown'

export interface AuditEvidence {
  schemaVersion: typeof AUDIT_SCHEMA_VERSION
  /** `E<n>` within one agent's round; `R<n>` for run-level records such as a stream gap. */
  id: string
  runId: string
  roundId: string
  /** Null for a run-level record that no single agent owns. */
  agentId: string | null
  sessionId: string | null
  observedAt: number
  source: AuditSource
  kind: AuditKind
  summary: string
  outcome?: AuditOutcome
  detail?: string
}

export interface AuditLimits {
  maxRecordsPerAgent: number
  maxBytesPerAgent: number
  maxBytesPerRound: number
}

export const DEFAULT_AUDIT_LIMITS: AuditLimits = {
  maxRecordsPerAgent: 1000,
  maxBytesPerAgent: 1024 * 1024,
  maxBytesPerRound: 16 * 1024 * 1024,
}

/** What produced the run's evidence, so a later reader knows which policy it describes. */
export interface AuditProvenance {
  sandbox: string
  isolation: string | null
  toolchainId: string | null
}

export interface CaptureCoverage {
  sealed: boolean
  verified: boolean
  tampered: boolean
}

export interface AgentCoverage {
  records: number
  /** Records refused at a cap or lost to a failed write. */
  dropped: number
  /** Records whose summary or detail was cut to its bound. */
  truncated: number
  capture: CaptureCoverage | null
}

export interface FrozenAudit {
  schemaVersion: typeof AUDIT_SCHEMA_VERSION
  runId: string
  roundId: string
  frozenAt: number
  /** When collection for this round began; null when the collector never saw the round start. */
  collectedFrom: number | null
  /** The last evidence row in the frozen set; later evidence rows for the round are late. */
  throughEventId: number
  digest: string
  provenance: AuditProvenance | null
  agents: Record<string, AgentCoverage>
  streamGaps: number
  sensors: Record<string, string>
}

export interface FrozenRoundAudit {
  frozen: FrozenAudit
  records: AuditEvidence[]
}

/** Stated with every frozen set: what the evidence covers and, as plainly, what it does not. */
export const AUDIT_SENSORS: Record<string, string> = {
  tool: 'Tool calls as the OpenCode event stream reported them: tool, target, outcome and bounded output.',
  permission: 'Permission requests and the unattended replies to them.',
  failure: 'Attempt failures recorded by the engine and provider errors reported by the stream.',
  integrity: 'Submission capture: whether it was sealed, verified unchanged, or tampered with.',
  network: 'Not observed directly: programs started inside a command can use whatever network the sandbox allows.',
  filesystem: 'Only the captured workspace manifest; file operations inside commands are not observed one by one.',
}

const MAX_SUMMARY_CHARS = 300
const MAX_DETAIL_BYTES = 2048

/** OpenCode 1.18.21's wording when a permission rule refused a tool call (seen September 15). */
const RULE_REFUSAL = 'The user has specified a rule which prevents you from using this specific tool call'

type Draft = Pick<AuditEvidence, 'sessionId' | 'observedAt' | 'source' | 'kind' | 'summary' | 'outcome' | 'detail'>

interface AgentState {
  seq: number
  records: number
  bytes: number
  dropped: number
  truncated: number
}

interface RoundState {
  runId: string
  roundId: string
  roundIdx: number
  startedAt: number | null
  frozen: boolean
  bytes: number
  runSeq: number
  runDropped: number
  streamGaps: number
  agents: Map<string, AgentState>
  openTools: Map<string, { agentId: string; draft: Draft }>
  settledTools: Set<string>
  pendingPermissions: Map<string, { agentId: string; draft: Draft }>
}

export function auditDigest(records: readonly AuditEvidence[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(records)).digest('hex')}`
}

function capChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text
  return Buffer.from(text).subarray(0, max).toString('utf8').replace(/�+$/, '')
}

export class AuditCollector {
  private readonly limits: AuditLimits
  private readonly now: () => number
  private current = new Map<string, RoundState>()

  constructor(
    private readonly repos: Pick<Repos, 'events'>,
    private readonly opts: {
      limits?: Partial<AuditLimits>
      provenance?: AuditProvenance
      now?: () => number
    } = {},
  ) {
    this.limits = { ...DEFAULT_AUDIT_LIMITS, ...opts.limits }
    this.now = opts.now ?? Date.now
  }

  /** Starts a round's collection; anything still held for the run's previous round is discarded. */
  beginRound(runId: string, roundId: string, roundIdx: number): void {
    this.current.set(runId, this.fresh(runId, roundId, roundIdx, this.now()))
  }

  /** Never throws: collecting evidence must not be able to fail a round. */
  record(event: EngineEvent): void {
    try {
      this.apply(event)
    } catch {
      /* counted nowhere on purpose: a throw here means the collector itself is broken */
    }
  }

  /**
   * Seals the round's evidence for judging. Open tool calls and unanswered permission requests
   * are recorded as unknown, each agent gets a capture-integrity record, and caps that dropped
   * records say so. `agentIds` is every agent in the round, so one with no evidence at all is
   * listed with zero records rather than silently absent.
   */
  freeze(runId: string, roundId: string, agentIds: readonly string[]): FrozenRoundAudit {
    let state = this.current.get(runId)
    if (!state || state.roundId !== roundId) {
      state = this.fresh(runId, roundId, -1, null)
      this.current.set(runId, state)
    }

    for (const { agentId, draft } of state.openTools.values()) {
      this.persist(state, agentId, { ...draft, outcome: 'unknown', detail: 'No final state was observed before judging.' })
    }
    state.openTools.clear()
    for (const { agentId, draft } of state.pendingPermissions.values()) {
      this.persist(state, agentId, { ...draft, outcome: 'unknown', detail: 'No reply was observed before judging.' })
    }
    state.pendingPermissions.clear()

    const captures = new Map<string, CaptureCoverage & { detail?: string }>()
    for (const row of this.repos.events.forRound(roundId, ['submission.captured', 'submission.tampered'])) {
      if (!row.agentId) continue
      const p = row.payload as { sealed?: unknown; verified?: unknown; tampered?: unknown; detail?: unknown }
      const prior = captures.get(row.agentId)
      if (row.type === 'submission.captured') {
        captures.set(row.agentId, { sealed: p.sealed === true, verified: p.verified === true, tampered: p.tampered === true || prior?.tampered === true })
      } else {
        captures.set(row.agentId, {
          sealed: prior?.sealed ?? false, verified: prior?.verified ?? false, tampered: true,
          ...(typeof p.detail === 'string' ? { detail: p.detail } : {}),
        })
      }
    }

    const at = this.now()
    for (const agentId of agentIds) {
      const capture = captures.get(agentId)
      this.persist(state, agentId, integrityDraft(capture, at), { uncapped: true })
      const agent = state.agents.get(agentId)
      if (agent && agent.dropped > 0) {
        this.persist(state, agentId, {
          sessionId: null, observedAt: at, source: 'runtime', kind: 'gap', outcome: 'unknown',
          summary: `${agent.dropped} further record(s) were not kept: the per-agent evidence limit was reached.`,
        }, { uncapped: true })
      }
    }
    if (state.runDropped > 0) {
      this.persist(state, null, {
        sessionId: null, observedAt: at, source: 'runtime', kind: 'gap', outcome: 'unknown',
        summary: `${state.runDropped} run-level record(s) were not kept: the round evidence limit was reached.`,
      }, { uncapped: true })
    }

    const rows = this.repos.events.forRound(roundId, [AUDIT_EVIDENCE_EVENT])
    const records = rows.map((r) => r.payload as AuditEvidence)
    const byAgent = new Map<string, number>()
    for (const r of records) if (r.agentId) byAgent.set(r.agentId, (byAgent.get(r.agentId) ?? 0) + 1)
    const frozen: FrozenAudit = {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      runId,
      roundId,
      frozenAt: at,
      collectedFrom: state.startedAt,
      throughEventId: rows.at(-1)?.id ?? 0,
      digest: auditDigest(records),
      provenance: this.opts.provenance ?? null,
      agents: Object.fromEntries(agentIds.map((agentId) => {
        const agent = state.agents.get(agentId)
        const capture = captures.get(agentId)
        return [agentId, {
          records: byAgent.get(agentId) ?? 0,
          dropped: agent?.dropped ?? 0,
          truncated: agent?.truncated ?? 0,
          capture: capture ? { sealed: capture.sealed, verified: capture.verified, tampered: capture.tampered } : null,
        }]
      })),
      streamGaps: state.streamGaps,
      sensors: AUDIT_SENSORS,
    }
    this.repos.events.append({ runId, roundId, agentId: null, type: AUDIT_FROZEN_EVENT, payload: frozen })
    state.frozen = true
    return { frozen, records }
  }

  private fresh(runId: string, roundId: string, roundIdx: number, startedAt: number | null): RoundState {
    return {
      runId, roundId, roundIdx, startedAt, frozen: false, bytes: 0, runSeq: 0, runDropped: 0, streamGaps: 0,
      agents: new Map(), openTools: new Map(), settledTools: new Set(), pendingPermissions: new Map(),
    }
  }

  private apply(event: EngineEvent): void {
    const state = this.current.get(event.runId)
    if (!state) return
    switch (event.type) {
      case 'agent.activity': {
        const item = event.item
        if (!item) {
          if (event.kind === 'file') {
            this.persist(state, event.agentId, {
              sessionId: null, observedAt: this.now(), source: 'provider_stream', kind: 'file',
              summary: `edited ${event.detail}`, outcome: 'completed',
            })
          }
          return
        }
        if (item.kind === 'tool') return this.tool(state, event.agentId, item)
        if (item.kind === 'error') {
          this.persist(state, event.agentId, {
            sessionId: item.sessionId || null, observedAt: item.observedAt, source: 'provider_stream',
            kind: 'failure', summary: item.summary, outcome: 'failed',
          })
        }
        // Text is the agent talking, not behaviour; reasoning never reaches here at all.
        return
      }
      case 'agent.permission': {
        const key = `${event.agentId}:${event.requestId}`
        if (event.state === 'asked') {
          const patterns = event.patterns?.length ? ` ${event.patterns.join(', ')}` : ''
          state.pendingPermissions.set(key, {
            agentId: event.agentId,
            draft: {
              sessionId: null, observedAt: event.at, source: 'policy', kind: 'permission',
              summary: `${event.permission ?? 'permission'}${patterns}`,
            },
          })
          return
        }
        const asked = state.pendingPermissions.get(key)
        state.pendingPermissions.delete(key)
        this.persist(state, event.agentId, {
          ...(asked?.draft ?? { sessionId: null, source: 'policy', kind: 'permission', summary: 'permission request' }),
          observedAt: event.at,
          outcome: event.reply === 'reject' ? 'denied' : 'allowed',
          detail: `reply: ${event.reply ?? 'unknown'}`,
        } as Draft)
        return
      }
      case 'agent.status': {
        if (event.status !== 'failed') return
        if (event.roundIdx !== undefined && event.roundIdx !== state.roundIdx) return
        this.persist(state, event.agentId, {
          sessionId: null, observedAt: this.now(), source: 'runtime', kind: 'failure', outcome: 'failed',
          summary: event.failure ? `${event.failure.code}: ${event.failure.message}` : 'The attempt failed.',
        })
        return
      }
      case 'bridge.status': {
        if (event.state !== 'reconnecting') return
        state.streamGaps++
        this.persist(state, null, {
          sessionId: null, observedAt: event.at, source: 'runtime', kind: 'gap', outcome: 'unknown',
          summary: `Event stream ${event.source} reconnecting; activity in the gap may be missing${event.message ? `: ${event.message}` : '.'}`,
        })
        return
      }
      default:
        return
    }
  }

  /** A tool call is written once, when it settles; a later update never rewrites that record. */
  private tool(state: RoundState, agentId: string, item: ActivityItemInput): void {
    const key = `${agentId}:${item.id}`
    if (state.settledTools.has(key)) return
    const draft: Draft = {
      sessionId: item.sessionId || null, observedAt: item.observedAt, source: 'provider_stream', kind: 'tool', summary: item.summary,
    }
    if (item.status === 'completed' || item.status === 'error') {
      state.openTools.delete(key)
      state.settledTools.add(key)
      const refused = item.status === 'error' && (item.output ?? '').includes(RULE_REFUSAL)
      this.persist(state, agentId, {
        ...draft,
        ...(refused ? { source: 'policy' as const, outcome: 'denied' as const } : { outcome: item.status === 'completed' ? 'completed' as const : 'failed' as const }),
        ...(item.output ? { detail: item.output } : {}),
      })
      return
    }
    state.openTools.set(key, { agentId, draft })
  }

  private persist(state: RoundState, agentId: string | null, draft: Draft, opts: { uncapped?: boolean } = {}): void {
    const agent = agentId === null ? null : this.agentState(state, agentId)
    const redactedSummary = redactSecrets(draft.summary)
    const summary = capChars(redactedSummary, MAX_SUMMARY_CHARS)
    const redactedDetail = draft.detail === undefined ? undefined : redactSecrets(draft.detail)
    const detail = redactedDetail === undefined ? undefined : capBytes(redactedDetail, MAX_DETAIL_BYTES)
    const cut = summary !== redactedSummary || detail !== redactedDetail
    const record: AuditEvidence = {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      id: agent ? `E${agent.seq + 1}` : `R${state.runSeq + 1}`,
      runId: state.runId,
      roundId: state.roundId,
      agentId,
      sessionId: draft.sessionId,
      observedAt: draft.observedAt,
      source: draft.source,
      kind: draft.kind,
      summary,
      ...(draft.outcome ? { outcome: draft.outcome } : {}),
      ...(detail !== undefined ? { detail } : {}),
    }
    const bytes = Buffer.byteLength(JSON.stringify(record))
    const refuse = () => {
      if (agent) agent.dropped++
      else state.runDropped++
    }
    if (!opts.uncapped) {
      const overAgent = agent !== null && (agent.records >= this.limits.maxRecordsPerAgent || agent.bytes + bytes > this.limits.maxBytesPerAgent)
      if (overAgent || state.bytes + bytes > this.limits.maxBytesPerRound) return refuse()
    }
    try {
      this.repos.events.append({
        runId: state.runId, roundId: state.roundId, agentId,
        type: state.frozen ? AUDIT_LATE_EVENT : AUDIT_EVIDENCE_EVENT,
        payload: record,
      })
    } catch {
      return refuse()
    }
    if (agent) {
      agent.seq++
      agent.records++
      agent.bytes += bytes
      if (cut) agent.truncated++
    } else {
      state.runSeq++
    }
    state.bytes += bytes
  }

  private agentState(state: RoundState, agentId: string): AgentState {
    let agent = state.agents.get(agentId)
    if (!agent) {
      agent = { seq: 0, records: 0, bytes: 0, dropped: 0, truncated: 0 }
      state.agents.set(agentId, agent)
    }
    return agent
  }
}

function integrityDraft(capture: (CaptureCoverage & { detail?: string }) | undefined, at: number): Draft {
  const base = { sessionId: null, observedAt: at, source: 'capture' as const, kind: 'integrity' as const }
  if (!capture) return { ...base, outcome: 'unknown', summary: 'No submission capture was recorded.' }
  if (capture.tampered) {
    return { ...base, outcome: 'failed', summary: 'The submission changed after it was captured.', ...(capture.detail ? { detail: capture.detail } : {}) }
  }
  if (!capture.sealed) {
    return { ...base, outcome: 'unknown', summary: 'Captured, but not certifiable: the agent was not confirmed stopped or another writer could reach its workspace.' }
  }
  return capture.verified
    ? { ...base, outcome: 'completed', summary: 'Sealed at capture and verified unchanged.' }
    : { ...base, outcome: 'unknown', summary: 'Sealed at capture; verification could not confirm it unchanged.' }
}

export interface RoundAuditView {
  /** `not_recorded`: no audit was collected (a round from before auditing, or a mock seam without one). */
  status: 'recorded' | 'collecting' | 'not_recorded'
  frozen: FrozenAudit | null
  /** The frozen set once frozen; everything collected so far before that. */
  records: AuditEvidence[]
  late: AuditEvidence[]
  /** Whether the stored frozen set still hashes to its digest; null before freezing. */
  digestMatches: boolean | null
}

/** The audit as persisted: the same view after a restart as before it. */
export function readRoundAudit(repos: Pick<Repos, 'events'>, roundId: string): RoundAuditView {
  const rows = repos.events.forRound(roundId, [AUDIT_EVIDENCE_EVENT, AUDIT_LATE_EVENT, AUDIT_FROZEN_EVENT])
  const frozenRow = rows.filter((r) => r.type === AUDIT_FROZEN_EVENT).at(-1)
  const frozen = frozenRow ? (frozenRow.payload as FrozenAudit) : null
  const evidence = rows.filter((r) => r.type === AUDIT_EVIDENCE_EVENT)
  const included = frozen ? evidence.filter((r) => r.id <= frozen.throughEventId) : evidence
  const late = [
    ...(frozen ? evidence.filter((r) => r.id > frozen.throughEventId) : []),
    ...rows.filter((r) => r.type === AUDIT_LATE_EVENT),
  ].sort((a, b) => a.id - b.id)
  const records = included.map((r) => r.payload as AuditEvidence)
  return {
    status: frozen ? 'recorded' : evidence.length > 0 ? 'collecting' : 'not_recorded',
    frozen,
    records,
    late: late.map((r) => r.payload as AuditEvidence),
    digestMatches: frozen ? auditDigest(records) === frozen.digest : null,
  }
}
