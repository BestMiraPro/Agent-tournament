import { randomUUID } from 'node:crypto'
import type { Db } from './open.js'
import type {
  AgentRow, GenomeOrigin, GenomeRow, JudgeMode, RoundStatus, RunConfig, ScoreRow, SubmissionStatus,
} from '../core/types.js'

const now = () => Date.now()
const id = () => randomUUID()

export interface RunRow {
  id: string
  name: string
  createdAt: number
  status: string
  config: RunConfig
  seedDir: string | null
  initialGoal: string | null
  /** Criteria supplied when the run was created: the round-1 draft default, never applied silently. */
  initialCriteria: string | null
}

/** One team-channel entry as recorded for its round. */
export interface ChannelMessageRow {
  roundId: string
  seq: number
  author: string
  /** The member whose label wrote it; null for a label that was not on the team. */
  agentId: string | null
  target: string | null
  postedAt: string
  body: string
  /** Agent ids the entry was forwarded to. */
  deliveredTo: string[]
  observedAt: number
}

/** One file of a collaboration round's sealed output folder, as captured. */
export interface TeamFileEntry {
  path: string
  bytes: number
  /** Null when the folder was too large to hash within the team budget. */
  sha256: string | null
  /** Not valid text (a NUL or an invalid UTF-8 sequence): listed and hashed, never shown. */
  binary: boolean
  /** Whether its text is stored with the snapshot (bounded per file and per round). */
  stored: boolean
}

/** Who did what in a collaboration round, from the frozen activity and the channel. */
export interface TeamContribution {
  label: string
  /** Workspace paths this member wrote or edited, as its activity reported them. */
  files: string[]
  posts: number
  toolCalls: number
}

export interface TeamOutputRow {
  roundId: string
  runId: string
  /** `ok`: something to judge. `no_submission`: output/ was empty. `error`: over the team quota. */
  status: SubmissionStatus
  errorText: string | null
  /** sha256 over the manifest and the channel: the seal the grader's copy is checked against. */
  digest: string
  /** Captured after every member was confirmed stopped, so nothing could still be writing. */
  sealed: boolean
  hashesComplete: boolean
  fileCount: number
  totalBytes: number
  files: TeamFileEntry[]
  channelMd: string | null
  channelSha256: string | null
  contributions: Record<string, TeamContribution>
  capturedAt: number
}

export interface TeamScoreRow {
  roundId: string
  runId: string
  score: number
  rationaleMd: string
  status: string
}

export interface RoundRow {
  id: string
  runId: string
  idx: number
  goalMd: string
  criteriaMd: string | null
  criteriaSource: string
  judgeMode: string
  status: RoundStatus
  metaDigest: string | null
  startedAt: number | null
  endedAt: number | null
  costUsd: number
}

/**
 * JSON has no representation for Infinity: `JSON.stringify` emits `null`, and reading that
 * back hands a non-number to consumers. `BudgetTracker` deliberately fails closed on a
 * non-number limit, so a run resumed from the database would throw rather than run
 * unlimited. These two functions preserve the sentinel across the round trip.
 */
const INFINITY_SENTINEL = '__Infinity__'

/** `submissions.usage_known`: 1 observed, 0 not observed, NULL recorded before tracking existed. */
function usageKnownOf(value: unknown): boolean | null {
  if (value === null || value === undefined) return null
  return value === 1
}

function encodeConfig(config: unknown): string {
  return JSON.stringify(config, (_k, v) => (v === Infinity ? INFINITY_SENTINEL : v))
}

function decodeConfig(json: string): RunConfig {
  const config = JSON.parse(json, (_k, v) => (v === INFINITY_SENTINEL ? Infinity : v)) as RunConfig
  // Runs stored before workflows existed were all tournaments; the app default is not what they ran as.
  return config.workflow === undefined ? { ...config, workflow: 'tournament' } : config
}

export function makeRepos(db: Db) {
  return {
    runs: {
      create(input: {
        name: string; initialGoal?: string | null; initialCriteria?: string | null; config: RunConfig; seedDir: string | null
      }): RunRow {
        const row: RunRow = {
          id: id(), name: input.name, createdAt: now(),
          status: 'active', config: input.config, seedDir: input.seedDir, initialGoal: input.initialGoal ?? null,
          initialCriteria: input.initialCriteria ?? null,
        }
        db.prepare(
          'INSERT INTO runs (id, name, created_at, status, config_json, seed_dir, initial_goal, initial_criteria) VALUES (?,?,?,?,?,?,?,?)',
        ).run(row.id, row.name, row.createdAt, row.status, encodeConfig(row.config), row.seedDir, row.initialGoal, row.initialCriteria)
        return row
      },
      get(runId: string): RunRow | null {
        const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as any
        if (!r) return null
        return {
          id: r.id, name: r.name, createdAt: r.created_at, status: r.status,
          config: decodeConfig(r.config_json), seedDir: r.seed_dir, initialGoal: r.initial_goal,
          initialCriteria: r.initial_criteria ?? null,
        }
      },
      updateConfig(runId: string, config: RunConfig): void {
        db.prepare('UPDATE runs SET config_json = ? WHERE id = ?').run(encodeConfig(config), runId)
      },
      setStatus(runId: string, status: string): void {
        // Loose string column ('active' at create); 'stopped' is the db-backed
        // stop marker (spec 3.3) the POST /rounds + PATCH /config guards key off.
        db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, runId)
      },
      list(): { id: string; name: string; createdAt: number }[] {
        const rows = db.prepare('SELECT id, name, created_at FROM runs ORDER BY created_at DESC').all() as any[]
        return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }))
      },
    },

    rounds: {
      create(input: { runId: string; idx: number; goalMd: string }): RoundRow {
        const row: RoundRow = {
          id: id(), runId: input.runId, idx: input.idx, goalMd: input.goalMd,
          criteriaMd: null, criteriaSource: 'generated', judgeMode: 'single_call',
          status: 'pending', metaDigest: null,
          startedAt: null, endedAt: null, costUsd: 0,
        }
        db.prepare(
          'INSERT INTO rounds (id, run_id, idx, goal_md, criteria_source, judge_mode, status) VALUES (?,?,?,?,?,?,?)',
        ).run(row.id, row.runId, row.idx, row.goalMd, row.criteriaSource, row.judgeMode, row.status)
        return row
      },
      get(roundId: string): RoundRow | null {
        const r = db.prepare('SELECT * FROM rounds WHERE id = ?').get(roundId) as any
        if (!r) return null
        return {
          id: r.id, runId: r.run_id, idx: r.idx, goalMd: r.goal_md,
          criteriaMd: r.criteria_md, criteriaSource: r.criteria_source,
          judgeMode: r.judge_mode, status: r.status, metaDigest: r.meta_digest,
          startedAt: r.started_at, endedAt: r.ended_at, costUsd: r.cost_usd,
        }
      },
      setStatus(roundId: string, status: RoundStatus): void {
        db.prepare('UPDATE rounds SET status = ? WHERE id = ?').run(status, roundId)
      },
      setCriteria(roundId: string, criteriaMd: string, source: 'user' | 'generated'): void {
        db.prepare('UPDATE rounds SET criteria_md = ?, criteria_source = ? WHERE id = ?')
          .run(criteriaMd, source, roundId)
      },
      setDigest(roundId: string, digest: string): void {
        db.prepare('UPDATE rounds SET meta_digest = ? WHERE id = ?').run(digest, roundId)
      },
      lastIdx(runId: string): number {
        const r = db.prepare('SELECT MAX(idx) AS m FROM rounds WHERE run_id = ?').get(runId) as any
        return r?.m ?? 0
      },
      listForRun(runId: string): RoundRow[] {
        const rows = db.prepare('SELECT * FROM rounds WHERE run_id = ? ORDER BY idx').all(runId) as any[]
        return rows.map((r) => ({
          id: r.id, runId: r.run_id, idx: r.idx, goalMd: r.goal_md,
          criteriaMd: r.criteria_md, criteriaSource: r.criteria_source,
          judgeMode: r.judge_mode, status: r.status, metaDigest: r.meta_digest,
          startedAt: r.started_at, endedAt: r.ended_at, costUsd: r.cost_usd,
        }))
      },
      markStarted(roundId: string): void {
        db.prepare('UPDATE rounds SET started_at = ? WHERE id = ?').run(now(), roundId)
      },
      markEnded(roundId: string, costUsd: number): void {
        db.prepare('UPDATE rounds SET ended_at = ?, cost_usd = ? WHERE id = ?')
          .run(now(), costUsd, roundId)
      },
      setJudgeMode(roundId: string, mode: JudgeMode): void {
        db.prepare('UPDATE rounds SET judge_mode = ? WHERE id = ?').run(mode, roundId)
      },
    },

    agents: {
      create(input: {
        runId: string; label: string; parentAgentId: string | null; bornRound: number
      }): AgentRow {
        const row: AgentRow = {
          id: id(), runId: input.runId, label: input.label,
          parentAgentId: input.parentAgentId, bornRound: input.bornRound,
          diedRound: null, status: 'active',
        }
        db.prepare(
          'INSERT INTO agents (id, run_id, label, parent_agent_id, born_round, died_round, status) VALUES (?,?,?,?,?,?,?)',
        ).run(row.id, row.runId, row.label, row.parentAgentId, row.bornRound, null, row.status)
        return row
      },
      listActive(runId: string): AgentRow[] {
        const rows = db.prepare(
          "SELECT * FROM agents WHERE run_id = ? AND status = 'active' ORDER BY label",
        ).all(runId) as any[]
        return rows.map((r) => ({
          id: r.id, runId: r.run_id, label: r.label, parentAgentId: r.parent_agent_id,
          bornRound: r.born_round, diedRound: r.died_round, status: r.status,
        }))
      },
      retire(agentId: string, roundIdx: number, status: 'retired' | 'culled'): void {
        db.prepare('UPDATE agents SET status = ?, died_round = ? WHERE id = ?')
          .run(status, roundIdx, agentId)
      },
      listAll(runId: string): AgentRow[] {
        const rows = db.prepare('SELECT * FROM agents WHERE run_id = ? ORDER BY rowid').all(runId) as any[]
        return rows.map((r) => ({
          id: r.id, runId: r.run_id, label: r.label, parentAgentId: r.parent_agent_id,
          bornRound: r.born_round, diedRound: r.died_round, status: r.status,
        }))
      },
    },

    genomes: {
      create(input: {
        agentId: string; roundIdx: number; strategyMd: string; notesMd: string
        modelId: string; temperature: number; parentGenomeId: string | null; origin: GenomeOrigin
      }): GenomeRow {
        const row: GenomeRow = { ...input, id: id(), createdAt: now() }
        db.prepare(
          'INSERT INTO genomes (id, agent_id, round_idx, strategy_md, notes_md, model_id, temperature, parent_genome_id, origin, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).run(
          row.id, row.agentId, row.roundIdx, row.strategyMd, row.notesMd,
          row.modelId, row.temperature, row.parentGenomeId, row.origin, row.createdAt,
        )
        return row
      },
      forRound(agentId: string, roundIdx: number): GenomeRow | null {
        const r = db.prepare('SELECT * FROM genomes WHERE agent_id = ? AND round_idx = ?')
          .get(agentId, roundIdx) as any
        if (!r) return null
        return {
          id: r.id, agentId: r.agent_id, roundIdx: r.round_idx, strategyMd: r.strategy_md,
          notesMd: r.notes_md, modelId: r.model_id, temperature: r.temperature,
          parentGenomeId: r.parent_genome_id, origin: r.origin, createdAt: r.created_at,
        }
      },
      forAgent(agentId: string): GenomeRow[] {
        const rows = db.prepare('SELECT * FROM genomes WHERE agent_id = ? ORDER BY round_idx').all(agentId) as any[]
        return rows.map((r) => ({
          id: r.id, agentId: r.agent_id, roundIdx: r.round_idx, strategyMd: r.strategy_md,
          notesMd: r.notes_md, modelId: r.model_id, temperature: r.temperature,
          parentGenomeId: r.parent_genome_id, origin: r.origin, createdAt: r.created_at,
        }))
      },
      /**
       * Every genome in a run, in one statement, keyed `<agentId>:<roundIdx>`.
       *
       * Callers that walk rounds x agents were issuing one `forRound` each: 10,000
       * statements and 229ms of synchronous SQLite for a 100-round, 100-agent run, on an
       * endpoint the dashboard polls. node:sqlite is synchronous, so that time blocks the
       * event loop — the websocket broadcasts and the round's own writes included. The
       * volume of data returned is unchanged (those callers read every genome anyway);
       * only the number of round trips drops.
       */
      forRunByRound(runId: string): Map<string, GenomeRow> {
        const rows = db.prepare(
          `SELECT g.* FROM genomes g
             JOIN agents a ON a.id = g.agent_id
            WHERE a.run_id = ?`,
        ).all(runId) as any[]
        const byAgentAndRound = new Map<string, GenomeRow>()
        for (const r of rows) {
          byAgentAndRound.set(`${r.agent_id}:${r.round_idx}`, {
            id: r.id, agentId: r.agent_id, roundIdx: r.round_idx, strategyMd: r.strategy_md,
            notesMd: r.notes_md, modelId: r.model_id, temperature: r.temperature,
            parentGenomeId: r.parent_genome_id, origin: r.origin, createdAt: r.created_at,
          })
        }
        return byAgentAndRound
      },
    },

    scores: {
      insertMany(roundId: string, rows: ScoreRow[]): void {
        const stmt = db.prepare(
          'INSERT INTO scores (id, round_id, agent_id, rank, score, rationale_md, band) VALUES (?,?,?,?,?,?,?)',
        )
        db.exec('BEGIN')
        try {
          for (const s of rows) {
            stmt.run(id(), roundId, s.agentId, s.rank, s.score, s.rationaleMd, s.band)
          }
          db.exec('COMMIT')
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
      },
      forRound(roundId: string): ScoreRow[] {
        const rows = db.prepare('SELECT * FROM scores WHERE round_id = ? ORDER BY rank')
          .all(roundId) as any[]
        return rows.map((r) => ({
          roundId: r.round_id, agentId: r.agent_id, rank: r.rank,
          score: r.score, rationaleMd: r.rationale_md, band: r.band,
        }))
      },
      forAgent(runId: string, agentId: string): (ScoreRow & { roundIdx: number })[] {
        const rows = db.prepare(
          'SELECT s.*, r.idx AS round_idx FROM scores s JOIN rounds r ON r.id = s.round_id ' +
            'WHERE s.agent_id = ? AND r.run_id = ? ORDER BY r.idx',
        ).all(agentId, runId) as any[]
        return rows.map((r) => ({
          roundId: r.round_id, agentId: r.agent_id, rank: r.rank,
          score: r.score, rationaleMd: r.rationale_md, band: r.band, roundIdx: r.round_idx,
        }))
      },
    },

    submissions: {
      create(input: {
        roundId: string; agentId: string; genomeId: string
        submissionMd: string | null; fileManifest: { path: string; bytes: number }[]
        workspacePath: string; status: SubmissionStatus; errorText: string | null
        tokensIn: number; tokensOut: number; tokensCacheRead: number; tokensCacheWrite: number
        costUsd: number; durationMs: number
        /** False when the token/cost fields are placeholders for usage nobody observed. */
        usageKnown?: boolean
      }): void {
        db.prepare(
          'INSERT INTO submissions (id, round_id, agent_id, genome_id, submission_md, file_manifest_json, workspace_path, status, error_text, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, cost_usd, duration_ms, usage_known) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          id(), input.roundId, input.agentId, input.genomeId, input.submissionMd,
          JSON.stringify(input.fileManifest), input.workspacePath, input.status, input.errorText,
          input.tokensIn, input.tokensOut, input.tokensCacheRead, input.tokensCacheWrite,
          input.costUsd, input.durationMs, input.usageKnown === false ? 0 : 1,
        )
      },
      forRound(roundId: string) {
        const rows = db.prepare('SELECT * FROM submissions WHERE round_id = ?').all(roundId) as any[]
        return rows.map((r) => ({
          id: r.id, roundId: r.round_id, agentId: r.agent_id, genomeId: r.genome_id,
          submissionMd: r.submission_md,
          fileManifest: r.file_manifest_json ? JSON.parse(r.file_manifest_json) : [],
          workspacePath: r.workspace_path, status: r.status, errorText: r.error_text,
          tokensIn: r.tokens_in, tokensOut: r.tokens_out,
          tokensCacheRead: r.tokens_cache_read, tokensCacheWrite: r.tokens_cache_write,
          costUsd: r.cost_usd, durationMs: r.duration_ms,
          usageKnown: usageKnownOf(r.usage_known),
        }))
      },
      forAgent(roundId: string, agentId: string) {
        const r = db.prepare('SELECT * FROM submissions WHERE round_id = ? AND agent_id = ?')
          .get(roundId, agentId) as any
        if (!r) return null
        // fileManifestJson stays raw (unlike forRound's parsed array): the
        // agent-detail endpoint parses it with a guard and must keep a missing
        // manifest distinct from an empty one.
        return {
          id: r.id, roundId: r.round_id, agentId: r.agent_id, genomeId: r.genome_id,
          submissionMd: r.submission_md, fileManifestJson: r.file_manifest_json,
          workspacePath: r.workspace_path, status: r.status, errorText: r.error_text,
          tokensIn: r.tokens_in, tokensOut: r.tokens_out,
          tokensCacheRead: r.tokens_cache_read, tokensCacheWrite: r.tokens_cache_write,
          costUsd: r.cost_usd, durationMs: r.duration_ms,
          usageKnown: usageKnownOf(r.usage_known),
        }
      },
      totalCost(roundId: string): number {
        const r = db.prepare('SELECT SUM(cost_usd) AS c FROM submissions WHERE round_id = ?')
          .get(roundId) as any
        return r?.c ?? 0
      },
    },

    /** Immutable grading records: one envelope per judged round, never rewritten. */
    judgingAudits: {
      insert(input: { roundId: string; payload: unknown }): void {
        db.prepare('INSERT INTO judging_audits (round_id, created_at, payload_json) VALUES (?,?,?)')
          .run(input.roundId, now(), JSON.stringify(input.payload))
      },
      forRound(roundId: string) {
        const rows = db.prepare('SELECT * FROM judging_audits WHERE round_id = ? ORDER BY id').all(roundId) as any[]
        return rows.map((r) => ({
          id: r.id as number, roundId: r.round_id as string, createdAt: r.created_at as number,
          payload: JSON.parse(r.payload_json),
        }))
      },
    },

    /** Collaboration: each round's sealed output folder. Written once, at capture. */
    teamOutputs: {
      insert(row: TeamOutputRow, contents: ReadonlyMap<string, string>): void {
        db.exec('BEGIN')
        try {
          db.prepare(
            'INSERT INTO round_outputs (round_id, run_id, status, error_text, digest, sealed, hashes_complete, file_count, total_bytes, manifest_json, channel_md, channel_sha256, contributions_json, captured_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          ).run(
            row.roundId, row.runId, row.status, row.errorText, row.digest, row.sealed ? 1 : 0, row.hashesComplete ? 1 : 0,
            row.fileCount, row.totalBytes, JSON.stringify(row.files), row.channelMd, row.channelSha256,
            JSON.stringify(row.contributions), row.capturedAt,
          )
          const file = db.prepare('INSERT INTO round_output_files (round_id, path, content) VALUES (?,?,?)')
          for (const [path, content] of contents) file.run(row.roundId, path, content)
          db.exec('COMMIT')
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
      },
      setContributions(roundId: string, contributions: Record<string, TeamContribution>): void {
        db.prepare('UPDATE round_outputs SET contributions_json = ? WHERE round_id = ?').run(JSON.stringify(contributions), roundId)
      },
      get(roundId: string): TeamOutputRow | null {
        const r = db.prepare('SELECT * FROM round_outputs WHERE round_id = ?').get(roundId) as any
        if (!r) return null
        return {
          roundId: r.round_id, runId: r.run_id, status: r.status, errorText: r.error_text, digest: r.digest,
          sealed: r.sealed === 1, hashesComplete: r.hashes_complete === 1, fileCount: r.file_count, totalBytes: r.total_bytes,
          files: JSON.parse(r.manifest_json), channelMd: r.channel_md, channelSha256: r.channel_sha256,
          contributions: JSON.parse(r.contributions_json), capturedAt: r.captured_at,
        }
      },
      /** A stored file's text; null when it is not stored (binary, too large) or not in the snapshot. */
      file(roundId: string, path: string): string | null {
        const r = db.prepare('SELECT content FROM round_output_files WHERE round_id = ? AND path = ?').get(roundId, path) as any
        return r ? r.content : null
      },
      /** Every stored file of a round, for the grader's copy and a rejudge. */
      files(roundId: string): { path: string; content: string }[] {
        const rows = db.prepare('SELECT path, content FROM round_output_files WHERE round_id = ? ORDER BY path').all(roundId) as any[]
        return rows.map((r) => ({ path: r.path, content: r.content }))
      },
    },

    /** Collaboration: one team score per round. */
    teamScores: {
      insert(row: TeamScoreRow): void {
        db.prepare('INSERT INTO team_scores (round_id, run_id, score, rationale_md, status, created_at) VALUES (?,?,?,?,?,?)')
          .run(row.roundId, row.runId, row.score, row.rationaleMd, row.status, now())
      },
      forRound(roundId: string): TeamScoreRow | null {
        const r = db.prepare('SELECT * FROM team_scores WHERE round_id = ?').get(roundId) as any
        if (!r) return null
        return { roundId: r.round_id, runId: r.run_id, score: r.score, rationaleMd: r.rationale_md, status: r.status }
      },
    },

    /** Collaboration channel entries, per round, in file order. */
    channel: {
      append(input: { runId: string } & Omit<ChannelMessageRow, 'deliveredTo' | 'observedAt'>): void {
        db.prepare(
          'INSERT INTO channel_messages (run_id, round_id, seq, author, agent_id, target, posted_at, body, delivered_json, observed_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).run(input.runId, input.roundId, input.seq, input.author, input.agentId, input.target, input.postedAt, input.body, '[]', now())
      },
      markDelivered(roundId: string, seqs: readonly number[], agentId: string): void {
        const read = db.prepare('SELECT delivered_json FROM channel_messages WHERE round_id = ? AND seq = ?')
        const write = db.prepare('UPDATE channel_messages SET delivered_json = ? WHERE round_id = ? AND seq = ?')
        for (const seq of seqs) {
          const row = read.get(roundId, seq) as { delivered_json: string } | undefined
          if (!row) continue
          const delivered = JSON.parse(row.delivered_json) as string[]
          if (!delivered.includes(agentId)) write.run(JSON.stringify([...delivered, agentId]), roundId, seq)
        }
      },
      forRound(roundId: string): ChannelMessageRow[] {
        const rows = db.prepare('SELECT * FROM channel_messages WHERE round_id = ? ORDER BY seq').all(roundId) as any[]
        return rows.map((r) => ({
          roundId: r.round_id, seq: r.seq, author: r.author, agentId: r.agent_id, target: r.target,
          postedAt: r.posted_at, body: r.body, deliveredTo: JSON.parse(r.delivered_json), observedAt: r.observed_at,
        }))
      },
    },

    events: {
      append(input: {
        runId: string; roundId: string | null; agentId: string | null
        type: string; payload: unknown
      }): void {
        db.prepare(
          'INSERT INTO events (run_id, round_id, agent_id, ts, type, payload_json) VALUES (?,?,?,?,?,?)',
        ).run(input.runId, input.roundId, input.agentId, now(), input.type, JSON.stringify(input.payload))
      },
      forRun(runId: string) {
        const rows = db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY id').all(runId) as any[]
        return rows.map((r) => ({
          id: r.id, runId: r.run_id, roundId: r.round_id, agentId: r.agent_id,
          ts: r.ts, type: r.type, payload: JSON.parse(r.payload_json),
        }))
      },
      /** One round's events in insertion order, optionally only these types. */
      forRound(roundId: string, types: readonly string[] = []) {
        const rows = (types.length > 0
          ? db.prepare(`SELECT * FROM events WHERE round_id = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY id`)
            .all(roundId, ...types)
          : db.prepare('SELECT * FROM events WHERE round_id = ? ORDER BY id').all(roundId)) as any[]
        return rows.map((r) => ({
          id: r.id as number, runId: r.run_id as string, roundId: r.round_id as string, agentId: r.agent_id as string | null,
          ts: r.ts as number, type: r.type as string, payload: JSON.parse(r.payload_json),
        }))
      },
    },
  }
}

export type Repos = ReturnType<typeof makeRepos>
