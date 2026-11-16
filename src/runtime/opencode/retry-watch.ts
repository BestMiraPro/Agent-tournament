import type { OpenCodeClient } from './client.js'

/**
 * Gives up on a prompt OpenCode keeps retrying. OpenCode retries a failed model call with
 * backoff and no end, so a provider error that will not clear by itself (a used-up free tier:
 * "Free usage limit reached", opencode 1.18.21, 16 November 2026) left the agent, or a judge or
 * reflection call, waiting for good. Its session status says when it is retrying; one that
 * names an action for a person to take, or that has retried this often, is not going to recover.
 */

/** How often a running prompt's session status is read. */
export const RETRY_POLL_MS = 5_000

/** Retries of a provider error after which the prompt is given up. */
export const RETRY_GIVE_UP_ATTEMPTS = 8

/** The failure code a given-up prompt is reported with. */
export const PROVIDER_LIMIT_CODE = 'PROVIDER_LIMIT'

export class ProviderStuckError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderStuckError'
  }
}

export interface RetryWatch {
  /** Rejects with a ProviderStuckError once the prompt should be given up; never resolves. */
  promise: Promise<never>
  stop(): void
}

export function watchRetries(
  client: Pick<OpenCodeClient, 'sessionRetry'>,
  sessionId: string,
  directory: string,
  opts: { pollMs?: number; giveUpAttempts?: number } = {},
): RetryWatch {
  const pollMs = opts.pollMs ?? RETRY_POLL_MS
  const giveUpAttempts = opts.giveUpAttempts ?? RETRY_GIVE_UP_ATTEMPTS
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const promise = new Promise<never>((_resolve, reject) => {
    const tick = async (): Promise<void> => {
      // A status that cannot be read is no evidence of a stuck provider.
      const retry = await Promise.resolve().then(() => client.sessionRetry(sessionId, directory)).catch(() => null)
      if (stopped) return
      if (retry && (retry.action || retry.attempt >= giveUpAttempts)) {
        const why = retry.action ? [retry.action.title, retry.action.message].filter(Boolean).join(': ') : retry.message
        reject(new ProviderStuckError(`The model provider keeps failing (${retry.attempt} retries): ${why}`))
        return
      }
      timer = setTimeout(() => void tick(), pollMs)
    }
    timer = setTimeout(() => void tick(), pollMs)
  })
  // Whoever stops the watch early never awaits it.
  promise.catch(() => {})
  return {
    promise,
    stop() {
      stopped = true
      clearTimeout(timer)
    },
  }
}
