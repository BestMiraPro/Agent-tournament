export interface RosterEntry {
  modelId: string
  count: number
  temperature: number
}

// Shape-only check for the builder rows: total is the raw count sum, errors
// are per-row messages naming the 1-based row. The server zod schema is the
// authority; this mirrors it client-side for immediacy only.
export function summarizeRoster(entries: RosterEntry[]): { total: number; errors: string[] } {
  const errors: string[] = []
  let total = 0
  for (let i = 0; i < entries.length; i++) {
    const row = i + 1
    const entry = entries[i] as RosterEntry
    total += entry.count
    if (entry.modelId.trim() === '') errors.push(`row ${row}: model is empty`)
    if (!Number.isInteger(entry.count) || entry.count < 1) {
      errors.push(`row ${row}: count must be an integer >= 1`)
    }
    if (!Number.isFinite(entry.temperature) || entry.temperature < 0 || entry.temperature > 2) {
      errors.push(`row ${row}: temperature must be a number in [0, 2]`)
    }
  }
  return { total, errors }
}
