import type { TournamentEngine } from '../engine/driver.js'
import type { BridgeHandle } from './event-bridge.js'
import type { RunManager } from './run-manager.js'
import type { ComposedRun } from './compose-run.js'
import type { RunSpec } from './run-spec.js'

export interface RunRecord {
  runId: string
  spec: RunSpec
  engine: TournamentEngine
  manager: RunManager
  composed: ComposedRun
  bridges: BridgeHandle[]
  warnings: string[]
  capacity: { committed: number; maxContainers: number } | null
}

export class RunRegistry {
  private records = new Map<string, RunRecord>()

  set(record: RunRecord): void {
    this.records.set(record.runId, record)
  }

  get(runId: string): RunRecord | null {
    return this.records.get(runId) ?? null
  }

  has(runId: string): boolean {
    return this.records.has(runId)
  }

  get size(): number {
    return this.records.size
  }
}
