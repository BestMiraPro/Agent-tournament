/**
 * Which round indices the detail panel may show, and which one it shows now.
 *
 * Extracted from RoundDetail because it carries a race that is invisible by inspection:
 * `busy` flips the instant the websocket reports it, while `lastRoundIdx` comes from the
 * HTTP snapshot and lags by one refresh. During that window on the very first round,
 * busy is true and lastRoundIdx is still 0 — and rounds are 1-indexed, so treating it as
 * the in-flight round asked the server for round 0 and logged a 404 every time a run
 * started.
 */
export function roundOptions(
  completedIdx: readonly number[],
  busy: boolean,
  lastRoundIdx: number,
): number[] {
  const completed = [...completedIdx].sort((a, b) => a - b)
  // Round indices start at 1. Anything below that is a stale-snapshot artefact.
  const inFlight = busy && lastRoundIdx >= 1 ? lastRoundIdx : null
  return inFlight !== null && !completed.includes(inFlight) ? [...completed, inFlight] : completed
}

/** The option actually displayed: the user's choice if still valid, else the newest. */
export function effectiveRound(options: readonly number[], selected: number | null): number | null {
  if (selected !== null && options.includes(selected)) return selected
  return options.length > 0 ? options[options.length - 1]! : null
}
