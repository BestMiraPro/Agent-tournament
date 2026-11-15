import { describe, expect, test } from 'vitest'
import { MockSandbox } from '../../../src/runtime/mock-sandbox.js'
import { OpenCodeAgentRunner } from '../../../src/runtime/opencode/agent-runner.js'
import { OpenCodeClient, type PromptBody, type PromptResponse } from '../../../src/runtime/opencode/client.js'
import { buildTeamPrompt, buildTeamSteeringPrompt } from '../../../src/runtime/team-prompt.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

/** One OpenCode server for the whole team: one session per member, prompts held open. */
class TeamClient extends OpenCodeClient {
  responses = new Map<string, ReturnType<typeof deferred<PromptResponse>>>()
  prompts: { sessionId: string; directory: string; body: PromptBody }[] = []
  queued: { sessionId: string; body: PromptBody }[] = []
  status: 'busy' | 'idle' = 'busy'
  private n = 0
  constructor() { super({ baseUrl: 'http://fake.invalid', timeoutMs: 50 }) }
  override async createSession() { return { id: `ses_${++this.n}` } }
  override async prompt(sessionId: string, directory: string, body: PromptBody) {
    this.prompts.push({ sessionId, directory, body })
    const d = deferred<PromptResponse>()
    this.responses.set(sessionId, d)
    return d.promise
  }
  override async promptAsync(sessionId: string, _directory: string, body: PromptBody) { this.queued.push({ sessionId, body }) }
  override async sessionStatus() { return this.status }
  override async abort() {}
}

const team = (label: string, teammates: string[]) => ({ label, teammates, postCommand: 'node /work/.opencode/arena/post.mjs' })
const ctx = (agentId: string, label: string, teammates: string[]) => ({
  agentId,
  genome: { strategyMd: `strategy of ${label}`, notesMd: '', modelId: 'wandb/zai-org/GLM-5.2', temperature: 0.6 },
  goalMd: 'build a model',
  timeoutMs: Infinity,
  team: team(label, teammates),
})
const handle = (agentId: string) => ({ agentId, workspacePath: '/work', baseUrl: 'http://fake.invalid' })
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('OpenCode runner in a collaboration team', () => {
  test('members run at once in one shared folder, each under its own profile with the team prompt', async () => {
    const client = new TeamClient()
    const runner = new OpenCodeAgentRunner(client, new MockSandbox())
    const a = runner.run(handle('A'), ctx('A', 'agent-01', ['agent-02']))
    const b = runner.run(handle('B'), ctx('B', 'agent-02', ['agent-01']))
    await settle()
    expect(client.prompts.map((p) => [p.directory, p.body.agent])).toEqual([['/work', 'member-agent-01'], ['/work', 'member-agent-02']])
    const text = (client.prompts[0]!.body.parts[0] as { text: string }).text
    expect(text).toBe(buildTeamPrompt('build a model', team('agent-01', ['agent-02'])))
    expect(text).toContain('Your teammates: agent-02.')
    expect(text).toContain('node /work/.opencode/arena/post.mjs agent-01 "your message"')
    expect(text).toContain('output/README.md')
    expect(client.prompts[0]!.body.system).toBe('strategy of agent-01')
    for (const d of client.responses.values()) d.resolve({ info: {} } as PromptResponse)
    // No SUBMISSION.md exists: a member's work is the team folder, captured by the engine.
    expect((await a).status).toBe('ok')
    expect((await b).status).toBe('ok')
  })

  test('a channel message is queued into a running member\'s session with its own profile, and never into a finished one', async () => {
    const client = new TeamClient()
    const runner = new OpenCodeAgentRunner(client, new MockSandbox())
    const a = runner.run(handle('A'), ctx('A', 'agent-01', ['agent-02']))
    await settle()
    expect(await runner.send(handle('A'), 'New on the team channel')).toBe(true)
    expect(client.queued).toEqual([{
      sessionId: 'ses_1',
      body: {
        model: { providerID: 'wandb', modelID: 'zai-org/GLM-5.2' }, agent: 'member-agent-01', system: 'strategy of agent-01',
        parts: [{ type: 'text', text: 'New on the team channel' }],
      },
    }])
    client.status = 'idle'
    expect(await runner.send(handle('A'), 'while idle')).toBe(false)
    client.status = 'busy'
    client.responses.get('ses_1')!.resolve({ info: {} } as PromptResponse)
    await a
    expect(await runner.send(handle('A'), 'after it finished')).toBe(false)
    expect(await runner.send(handle('Z'), 'never started')).toBe(false)
    expect(client.queued).toHaveLength(1)
  })

  test('a non-team run is still refused a folder another run is using', async () => {
    const client = new TeamClient()
    const runner = new OpenCodeAgentRunner(client, new MockSandbox())
    void runner.run(handle('A'), ctx('A', 'agent-01', []))
    await settle()
    const solo = { agentId: 'B', genome: ctx('B', 'x', []).genome, goalMd: 'g', timeoutMs: Infinity }
    await expect(runner.run(handle('B'), solo)).rejects.toThrow(/still active/)
  })

  test('the steering message tells a member to finish its part of output/ and the README', () => {
    const text = buildTeamSteeringPrompt(3_600_000, team('agent-01', ['agent-02']))
    expect(text).toMatch(/1 hour/)
    expect(text).toContain('output/README.md')
    expect(text).toContain('node /work/.opencode/arena/post.mjs agent-01')
  })
})
