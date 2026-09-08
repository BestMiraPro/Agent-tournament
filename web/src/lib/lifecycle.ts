/** Small production gate for operations whose UI state cannot update until React rerenders. */
export function createStartGate() {
  let pending = false
  return {
    tryStart() { if (pending) return false; pending = true; return true },
    finish() { pending = false },
    get pending() { return pending },
  }
}

export function createSelectionGuard() {
  let request = 0
  let identity = ''
  return {
    select(next: string) { identity = next; request++; return request },
    begin(current: string) { identity = current; return ++request },
    current(current: string, id: number) { return identity === current && request === id },
  }
}

export function shouldHydrateCriteria(dirty: boolean): boolean {
  return !dirty
}

export function isCurrentRunRequest(selectedRun: string | null, runId: string, currentNavigation: number, requestNavigation: number): boolean {
  return selectedRun === runId && currentNavigation === requestNavigation
}
