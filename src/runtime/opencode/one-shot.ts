import type { OpenCodeClient, PromptBody, PromptResponse } from './client.js'

/** What a one-shot call leaves behind when it could not finish cleanly. */
export interface AbandonedSession {
  sessionId: string
  reason: string
}

/**
 * One non-agentic model call: create a session, prompt it, and if the prompt does not come
 * back with a result, ask the server to stop generating.
 *
 * Judge, reflect, criteria and capability probes all took the create-then-prompt path and
 * simply let a rejection propagate, so every timeout or transport failure left a session
 * live on the server — still generating, still spending. The probe made it worse by
 * retrying three times, abandoning one session per attempt.
 *
 * The abort is deliberately fire-and-forget. B15 settled that an abort acknowledgement is
 * not proof of termination, so there is nothing to be gained by waiting for one — and
 * waiting would let an unresponsive abort endpoint hang a call that has already failed.
 * Unlike an agent run there is no workspace to protect here: the point is to stop paying
 * for output nobody will read, and to say honestly that the session was left unconfirmed.
 *
 * `onAbandoned` is called for exactly those sessions, so a caller can report them rather
 * than discover them as unexplained spend.
 */
export async function promptOnce(
  client: OpenCodeClient,
  directory: string,
  title: string,
  body: PromptBody,
  timeoutMs: number,
  onAbandoned?: (session: AbandonedSession) => void,
): Promise<PromptResponse> {
  // A failure here created nothing, so there is nothing to stop.
  const session = await client.createSession(directory, title)
  try {
    return await client.prompt(session.id, directory, body, timeoutMs)
  } catch (e) {
    onAbandoned?.({
      sessionId: session.id,
      reason: e instanceof Error ? e.message.slice(0, 200) : String(e),
    })
    // Never awaited, and never allowed to replace the real failure below.
    void Promise.resolve()
      .then(() => client.abort(session.id, directory))
      .catch(() => {})
    throw e
  }
}
