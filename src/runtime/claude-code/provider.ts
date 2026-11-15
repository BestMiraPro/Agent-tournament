import { randomBytes } from 'node:crypto'
import type { CallPurpose, CompleteRequest, Provider } from '../provider.js'
import type { ProviderUsage } from '../opencode/provider.js'
import { providerArgs } from './argv.js'
import { claudeEnvVars, type ClaudeCredentials } from './env.js'
import { claudeLimitGate, type SubscriptionLimitGate } from './limit-gate.js'
import { requireClaudeModel } from './model-id.js'
import type { ClaudeLauncher } from './process.js'
import { ClaudeStreamTranslator, classifyClaudeFailure } from './stream.js'

/** Replaces Claude Code's coding-agent prompt for one-shot grading and rewriting calls. */
export const PROVIDER_SYSTEM_PROMPT =
  'You answer one request inside Agent Tournament, an evaluation harness. Follow the request exactly and give only what it asks for.'

const GRADING: readonly CallPurpose[] = ['judge', 'criteria', 'review']

export interface ClaudeCodeProviderOptions {
  launcher: ClaudeLauncher
  credentials: () => Promise<ClaudeCredentials>
  /** A private CLI config folder (token mode), or null for the host's. */
  configDir?: () => Promise<string | null>
  /** Working directory of every call: an empty folder of the run's. */
  directory: string
  /** The run's context folder, readable by grading calls only. */
  contextDir?: string | null
  /** Per call; `Infinity` for none. */
  timeoutMs: number
  limitGate?: SubscriptionLimitGate
}

/**
 * Judge, criteria, review and reflect calls on the Claude subscription, through `claude -p`.
 *
 * When the caller passes a JSON Schema the CLI's `--json-schema` constrains the answer and the
 * validated object comes back as JSON text, as OpenCode's structured output does; otherwise the text
 * goes through the caller's own zod parsing. Grading calls may read the context folder; nothing may
 * search the web.
 */
export class ClaudeCodeProvider implements Provider {
  public usage: ProviderUsage = {
    costUsd: 0, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, calls: 0, abandonedSessions: 0,
  }
  private gate: SubscriptionLimitGate

  constructor(private opts: ClaudeCodeProviderOptions) {
    this.gate = opts.limitGate ?? claudeLimitGate
  }

  async complete(req: CompleteRequest): Promise<string> {
    return (await this.completeRich(req)).text
  }

  async completeRich(req: CompleteRequest): Promise<{ text: string; reasoning: string | null }> {
    const model = requireClaudeModel(req.modelId)
    const fail = (message: string): never => {
      throw new Error(`ClaudeCodeProvider ${req.purpose} on ${req.modelId} failed: ${message}`)
    }
    const blocked = this.gate.blocked()
    if (blocked) fail(blocked.message)
    const credentials = await this.opts.credentials()
    const configDir = (await this.opts.configDir?.()) ?? null
    const readable = GRADING.includes(req.purpose) && this.opts.contextDir ? [this.opts.contextDir] : []
    const args = providerArgs({
      model, systemPrompt: PROVIDER_SYSTEM_PROMPT, readableDirs: readable,
      ...(req.schema !== undefined ? { schema: req.schema } : {}),
    })
    const { settings, secrets } = claudeEnvVars({ credentials, tokenTransport: 'fd', configDir, model })
    const proc = this.opts.launcher.launch(
      { agentId: `${req.purpose}-call`, workspacePath: this.opts.directory, baseUrl: '' },
      {
        args, settings, secrets, cwd: this.opts.directory, key: `${req.purpose}-${randomBytes(4).toString('hex')}`,
        ...(credentials.mode === 'token' ? { token: credentials.token } : {}),
      },
    )
    let stdout = ''
    let stderr = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (d: string) => { stdout += d })
    proc.stderr.on('data', (d: Buffer | string) => { stderr = (stderr + String(d)).slice(-4000) })
    const drained = new Promise<void>((resolve) => { proc.stdout.once('end', () => resolve()); proc.stdout.once('close', () => resolve()) })
    proc.stdin.end(req.prompt)

    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      proc.exited.then((e) => ({ kind: 'exit' as const, e })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        if (Number.isFinite(this.opts.timeoutMs)) timer = setTimeout(() => resolve({ kind: 'timeout' }), this.opts.timeoutMs)
      }),
    ]).finally(() => clearTimeout(timer))
    if (outcome.kind === 'timeout') {
      this.usage.abandonedSessions++
      await proc.kill().catch(() => {})
      fail(`no answer within ${this.opts.timeoutMs}ms`)
    }
    await Promise.race([drained, new Promise<void>((resolve) => setTimeout(resolve, 2000).unref())])
    if (outcome.kind === 'exit' && outcome.e.error) {
      fail(outcome.e.error.code === 'ENOENT' ? 'the Claude Code CLI could not be started' : outcome.e.error.message)
    }
    // Sweep any tool process the call left behind.
    await proc.kill().catch(() => {})

    const translator = new ClaudeStreamTranslator()
    const parsed = parseResult(stdout)
    if (parsed) for (const effect of translator.feed(parsed)) if (effect.type === 'rate_limit') this.gate.observe(effect.reading)
    const result = translator.result
    this.usage.calls++
    if (result?.usage) {
      this.usage.tokensIn += result.usage.tokensIn
      this.usage.tokensOut += result.usage.tokensOut
      this.usage.tokensCacheRead += result.usage.tokensCacheRead
      this.usage.tokensCacheWrite += result.usage.tokensCacheWrite
    }
    if (!result || result.isError) {
      const failure = classifyClaudeFailure({ result, text: result ? '' : stderr })
      if (failure.code === 'SUBSCRIPTION_LIMIT') this.gate.observe({ status: 'rejected', rateLimitType: null, resetsAt: null, utilization: null })
      fail(failure.message)
    }
    const text = req.schema !== undefined && result!.structured !== null ? JSON.stringify(result!.structured) : result!.text
    return { text, reasoning: null }
  }

  describe(): string {
    return 'claude-code'
  }
}

/** The CLI's single JSON result: the whole stdout, or failing that its last JSON line. */
function parseResult(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const lines = trimmed.split('\n').filter((l) => l.trim().startsWith('{'))
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]!)
      } catch {
        /* keep looking */
      }
    }
    return null
  }
}
