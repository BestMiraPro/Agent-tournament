/** `review`: the behavioural review of attempts that produced nothing to grade. */
export type CallPurpose = 'judge' | 'reflect' | 'criteria' | 'review'

export interface CompleteRequest {
  purpose: CallPurpose
  prompt: string
  modelId: string
  /**
   * When present, providers that support schema-constrained output should use it and
   * return `JSON.stringify(validatedObject)`. Callers parse the string exactly as before,
   * so this is transparent to `Judge` and `Reflector`, and `MockProvider` may ignore it.
   */
  schema?: unknown
}

export interface Provider {
  complete(req: CompleteRequest): Promise<string>
  /**
   * The same call with the model's reasoning trace alongside the text, when the
   * runtime exposes one. Optional so text-only providers (mocks, capability probes)
   * keep working untouched — callers fall back to `complete` and record null.
   */
  completeRich?(req: CompleteRequest): Promise<{ text: string; reasoning: string | null }>
  /** The runtime that answers calls, recorded with grading audits: `opencode` or `mock`. */
  describe?(): string
}
