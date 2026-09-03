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

  list(): RunRecord[] {
    return [...this.records.values()]
  }
}

/**
 * Tears a run down in dependency order: stop the event bridges first so no
 * more agent activity is relayed, then release sandbox/server resources, then
 * let the run manager dispose whatever round state remains. Never throws —
 * shutdown must not break on one run.
 */
export async function disposeRunRecord(record: RunRecord): Promise<void> {
  for (const bridge of record.bridges) {
    try {
      bridge.stop()
    } catch {
      /* one stuck bridge must not strand the rest */
    }
  }
  await record.composed.cleanup().catch(() => {})
  await record.manager.disposeAll().catch(() => {})
}
