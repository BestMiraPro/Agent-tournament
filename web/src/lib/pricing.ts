export interface ModelPrice {
  inPerM: number
  outPerM: number
  cacheReadPerM: number
  cacheWritePerM: number
}

// One `modelId inPerM outPerM cacheReadPerM cacheWritePerM` per line. All four
// rates are required: the engine preflight (BudgetTracker assertPrice)
// fail-closes on cache-less entries, so a short line is a wrong-arity error,
// not a default. Blank lines are skipped; an all-blank text is empty pricing
// (no custom pricing), not an error.
export function parsePricing(text: string): { pricing: Record<string, ModelPrice> | null; error: string | null } {
  const pricing: Record<string, ModelPrice> = {}
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? ''
    if (!line) continue
    const parts = line.split(/\s+/)
    if (parts.length !== 5 || !parts[0]) {
      return { pricing: null, error: `Pricing line ${i + 1} must look like \`modelId inPerM outPerM cacheReadPerM cacheWritePerM\`: ${line}` }
    }
    const [modelId, inS, outS, readS, writeS] = parts as [string, string, string, string, string]
    const rates = [inS, outS, readS, writeS].map(Number)
    if (rates.some((r) => !Number.isFinite(r))) {
      return { pricing: null, error: `Pricing line ${i + 1} has a non-numeric rate: ${line}` }
    }
    if (rates.some((r) => r < 0)) {
      return { pricing: null, error: `Pricing line ${i + 1} has a negative rate: ${line}` }
    }
    const [inPerM, outPerM, cacheReadPerM, cacheWritePerM] = rates as [number, number, number, number]
    pricing[modelId] = { inPerM, outPerM, cacheReadPerM, cacheWritePerM }
  }
  return { pricing, error: null }
}
