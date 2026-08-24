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

export function makeRepos(db: Db) {
  return {
    runs: {
      create(input: { name: string; config: RunConfig; seedDir: string | null }): RunRow {
        const row: RunRow = {
          id: id(), name: input.name, createdAt: now(),
          status: 'active', config: input.config, seedDir: input.seedDir,
        }
        db.prepare(
          'INSERT INTO runs (id, name, created_at, status, config_json, seed_dir) VALUES (?,?,?,?,?,?)',
        ).run(row.id, row.name, row.createdAt, row.status, JSON.stringify(row.config), row.seedDir)
        return row
      },
      get(runId: string): RunRow | null {
        const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as any
        if (!r) return null
        return {
          id: r.id, name: r.name, createdAt: r.created_at, status: r.status,
          config: JSON.parse(r.config_json), seedDir: r.seed_dir,
        }
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
    },

    submissions: {
      create(input: {
        roundId: string; agentId: string; genomeId: string
        submissionMd: string | null; fileManifest: { path: string; bytes: number }[]
        workspacePath: string; status: SubmissionStatus; errorText: string | null
        tokensIn: number; tokensOut: number; tokensCacheRead: number; tokensCacheWrite: number
        costUsd: number; durationMs: number
      }): void {
        db.prepare(
          'INSERT INTO submissions (id, round_id, agent_id, genome_id, submission_md, file_manifest_json, workspace_path, status, error_text, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, cost_usd, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          id(), input.roundId, input.agentId, input.genomeId, input.submissionMd,
          JSON.stringify(input.fileManifest), input.workspacePath, input.status, input.errorText,
          input.tokensIn, input.tokensOut, input.tokensCacheRead, input.tokensCacheWrite,
          input.costUsd, input.durationMs,
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
        }))
      },
      totalCost(roundId: string): number {
        const r = db.prepare('SELECT SUM(cost_usd) AS c FROM submissions WHERE round_id = ?')
          .get(roundId) as any
        return r?.c ?? 0
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
    },
  }
}

export type Repos = ReturnType<typeof makeRepos>
