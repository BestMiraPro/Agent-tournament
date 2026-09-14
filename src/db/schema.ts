export const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  seed_dir TEXT,
  initial_goal TEXT,
  initial_criteria TEXT
);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  idx INTEGER NOT NULL,
  goal_md TEXT NOT NULL,
  criteria_md TEXT,
  criteria_source TEXT NOT NULL,
  judge_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  meta_digest TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  UNIQUE(run_id, idx)
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  label TEXT NOT NULL,
  parent_agent_id TEXT REFERENCES agents(id),
  born_round INTEGER NOT NULL,
  died_round INTEGER,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS genomes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  round_idx INTEGER NOT NULL,
  strategy_md TEXT NOT NULL,
  notes_md TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL,
  temperature REAL NOT NULL,
  parent_genome_id TEXT REFERENCES genomes(id),
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(agent_id, round_idx)
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  genome_id TEXT NOT NULL REFERENCES genomes(id),
  submission_md TEXT,
  file_manifest_json TEXT,
  workspace_path TEXT NOT NULL,
  status TEXT NOT NULL,
  error_text TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  tokens_cache_read INTEGER DEFAULT 0,
  tokens_cache_write INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  duration_ms INTEGER,
  UNIQUE(round_id, agent_id)
);

CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  rationale_md TEXT NOT NULL,
  band TEXT,
  UNIQUE(round_id, agent_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  round_id TEXT,
  agent_id TEXT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_genomes_agent ON genomes(agent_id, round_idx);
CREATE INDEX IF NOT EXISTS idx_scores_round ON scores(round_id, rank);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
`
