import type { WebTool } from './evidence.js'

/**
 * Per-run call limits for the web tools: per agent, so one agent cannot spend the run's share, and
 * per run, so a run cannot exhaust the free search quota the next run needs. Counted when a call
 * is admitted; refused calls are numbered too, so every call has an id in the run's evidence.
 * Closed when the run stops: from then on everything is refused.
 */

export interface WebLimits {
  searchesPerAgent: number
  fetchesPerAgent: number
  searchesPerRun: number
  fetchesPerRun: number
}

export const DEFAULT_WEB_LIMITS: WebLimits = { searchesPerAgent: 200, fetchesPerAgent: 500, searchesPerRun: 2000, fetchesPerRun: 5000 }

export type Admission =
  | { ok: true; seq: number }
  | { ok: false; seq: number; reason: 'agent_limit' | 'run_limit' | 'run_stopped'; message: string }

export class WebLimiter {
  readonly limits: WebLimits
  private seq = 0
  private closed = false
  private runCount: Record<WebTool, number> = { web_search: 0, web_fetch: 0 }
  private agentCount = new Map<string, Record<WebTool, number>>()

  constructor(limits: Partial<WebLimits> = {}) {
    this.limits = { ...DEFAULT_WEB_LIMITS, ...limits }
  }

  admit(agentId: string, tool: WebTool): Admission {
    const seq = ++this.seq
    const noun = tool === 'web_search' ? 'web searches' : 'web fetches'
    if (this.closed) return { ok: false, seq, reason: 'run_stopped', message: 'This run has stopped; the web tools are no longer available.' }
    const perAgent = tool === 'web_search' ? this.limits.searchesPerAgent : this.limits.fetchesPerAgent
    const perRun = tool === 'web_search' ? this.limits.searchesPerRun : this.limits.fetchesPerRun
    let agent = this.agentCount.get(agentId)
    if (!agent) {
      agent = { web_search: 0, web_fetch: 0 }
      this.agentCount.set(agentId, agent)
    }
    if (agent[tool] >= perAgent) {
      return { ok: false, seq, reason: 'agent_limit', message: `This agent has used all ${perAgent} ${noun} it is allowed in this run.` }
    }
    if (this.runCount[tool] >= perRun) {
      return { ok: false, seq, reason: 'run_limit', message: `This run has used all ${perRun} ${noun} it is allowed.` }
    }
    agent[tool]++
    this.runCount[tool]++
    return { ok: true, seq }
  }

  close(): void {
    this.closed = true
  }

  get isClosed(): boolean {
    return this.closed
  }
}
