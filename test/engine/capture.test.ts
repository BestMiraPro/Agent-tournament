import { describe, expect, test } from 'vitest'
import {
  captureSubmission,
  checkQuota,
  quiesceAgent,
  verifyCapture,
  workspaceIsolated,
} from '../../src/engine/capture.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'
import type { AgentHandle } from '../../src/runtime/sandbox.js'

const setup = async () => {
  const sb = new MockSandbox()
  const h = await sb.provision('a1', {})
  return { sb, h }
}

/** Capture taken under the condition the driver guarantees: nothing is executing. */
const stopped = { executionStopped: true }

describe('captureSubmission', () => {
  test('captures the submission text and its hash', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'my answer')
    const c = await captureSubmission(sb, h)
    expect(c.submissionMd).toBe('my answer')
    expect(c.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('records a null submission when the file is absent', async () => {
    const { sb, h } = await setup()
    const c = await captureSubmission(sb, h)
    expect(c.submissionMd).toBeNull()
    expect(c.sha256).toBeNull()
  })

  test('captures the file manifest alongside', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    await sb.writeFile(h, 'notes.txt', 'yy')
    const c = await captureSubmission(sb, h)
    expect(c.files.map((f) => f.path).sort()).toEqual(['SUBMISSION.md', 'notes.txt'])
  })

  test('records when it was taken', async () => {
    const { sb, h } = await setup()
    const before = Date.now()
    const c = await captureSubmission(sb, h)
    expect(c.capturedAt).toBeGreaterThanOrEqual(before)
  })

  // Amendment (B): every file in the manifest is hashed, not just SUBMISSION.md.
  test('hashes every file in the manifest', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    await sb.writeFile(h, 'evidence/data.csv', 'a,b\n1,2\n')
    const c = await captureSubmission(sb, h)
    expect(Object.keys(c.hashes).sort()).toEqual(['SUBMISSION.md', 'evidence/data.csv'])
    for (const digest of Object.values(c.hashes)) expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(c.hashesComplete).toBe(true)
  })

  // Amendment (A): a capture is only sealed when the caller proved nothing can write.
  test('is unsealed unless the caller states that execution has stopped', async () => {
    const { sb, h } = await setup()
    expect((await captureSubmission(sb, h)).sealed).toBe(false)
    expect((await captureSubmission(sb, h, stopped)).sealed).toBe(true)
  })

  test('refuses to hash a workspace larger than the hash budget', async () => {
    const { sb, h } = await setup()
    for (let i = 0; i < 20; i++) await sb.writeFile(h, `f${i}.txt`, 'x')
    const c = await captureSubmission(sb, h, {
      ...stopped,
      hashBudget: { maxFiles: 5, maxBytes: 1_000_000 },
    })
    expect(c.hashesComplete).toBe(false)
    expect(c.files).toHaveLength(20)
  })
})

describe('verifyCapture', () => {
  test('reports intact when the file is unchanged', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'original')
    const c = await captureSubmission(sb, h)
    expect((await verifyCapture(sb, h, c)).tampered).toBe(false)
  })

  test('detects a submission modified after capture', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'original')
    const c = await captureSubmission(sb, h)
    await sb.writeFile(h, 'SUBMISSION.md', 'sabotaged')
    expect((await verifyCapture(sb, h, c)).tampered).toBe(true)
  })

  test('detects a submission deleted after capture', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'original')
    const c = await captureSubmission(sb, h)
    await sb.reset(h, {})
    const v = await verifyCapture(sb, h, c)
    expect(v.tampered).toBe(true)
    expect(v.detail).toMatch(/missing|deleted/i)
  })

  test('an agent that never submitted is not reported as tampered', async () => {
    const { sb, h } = await setup()
    const c = await captureSubmission(sb, h)
    expect((await verifyCapture(sb, h, c)).tampered).toBe(false)
  })

  // Amendment (B): auxiliary files the judge may read are covered too.
  test('detects an auxiliary file modified after capture', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'original')
    await sb.writeFile(h, 'evidence/data.csv', 'a,b\n1,2\n')
    const c = await captureSubmission(sb, h)
    await sb.writeFile(h, 'evidence/data.csv', 'a,b\n9,9\n')
    const v = await verifyCapture(sb, h, c, stopped)
    expect(v.tampered).toBe(true)
    expect(v.detail).toMatch(/data\.csv/)
  })

  test('detects an auxiliary file deleted after capture', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'original')
    await sb.writeFile(h, 'notes.txt', 'kept')
    const c = await captureSubmission(sb, h)
    await sb.reset(h, {})
    await sb.writeFile(h, 'SUBMISSION.md', 'original')
    const v = await verifyCapture(sb, h, c, stopped)
    expect(v.tampered).toBe(true)
    expect(v.detail).toMatch(/notes\.txt/)
  })

  test('detects a file planted after capture', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'original')
    const c = await captureSubmission(sb, h)
    await sb.writeFile(h, 'planted.md', 'read me instead')
    const v = await verifyCapture(sb, h, c, stopped)
    expect(v.tampered).toBe(true)
    expect(v.detail).toMatch(/planted\.md/)
  })

  // Amendment (A): "intact" is only a claim worth making when nothing can still write.
  test('does not certify a capture while execution may still be running', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'original')
    const c = await captureSubmission(sb, h)
    const v = await verifyCapture(sb, h, c)
    expect(v.tampered).toBe(false)
    expect(v.verified).toBe(false)
  })

  test('certifies only once the caller states that execution has stopped', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'original')
    const c = await captureSubmission(sb, h, stopped)
    const v = await verifyCapture(sb, h, c, stopped)
    expect(v.tampered).toBe(false)
    expect(v.verified).toBe(true)
  })

  // Amendment (A), at the unit level: the substitution is already in the captured bytes,
  // so re-reading agrees with them. "Unchanged" must not become "intact".
  test('never certifies an unsealed capture as intact', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'rival substitute')
    const c = await captureSubmission(sb, h, { executionStopped: false })
    const v = await verifyCapture(sb, h, c, stopped)
    expect(v.tampered).toBe(false)
    expect(v.verified).toBe(false)
  })

  // A difference is an observed fact, so a positive finding survives an unsealed
  // capture — otherwise honesty about the window would cost every detection too.
  test('still certifies a positive finding taken from an unsealed capture', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'original')
    const c = await captureSubmission(sb, h, { executionStopped: false })
    await sb.writeFile(h, 'SUBMISSION.md', 'sabotaged')
    const v = await verifyCapture(sb, h, c, stopped)
    expect(v.tampered).toBe(true)
    expect(v.verified).toBe(true)
  })

  test('never certifies a capture whose hashes are incomplete', async () => {
    const { sb, h } = await setup()
    for (let i = 0; i < 20; i++) await sb.writeFile(h, `f${i}.txt`, 'x')
    const c = await captureSubmission(sb, h, {
      ...stopped,
      hashBudget: { maxFiles: 5, maxBytes: 1_000_000 },
    })
    expect((await verifyCapture(sb, h, c, stopped)).verified).toBe(false)
  })
})

describe('quiesceAgent', () => {
  test('reports unsupported when the runner cannot stop an agent', async () => {
    const h: AgentHandle = { agentId: 'a1', workspacePath: '/w', baseUrl: '' }
    expect(await quiesceAgent({ run: async () => ({}) }, h)).toBe('unsupported')
  })

  test('returns the runner verdict when it can', async () => {
    const h: AgentHandle = { agentId: 'a1', workspacePath: '/w', baseUrl: '' }
    const runner = { run: async () => ({}), quiesce: async () => 'stopped' as const }
    expect(await quiesceAgent(runner, h)).toBe('stopped')
  })

  test('a runner that throws while stopping is unconfirmed, not fatal', async () => {
    const h: AgentHandle = { agentId: 'a1', workspacePath: '/w', baseUrl: '' }
    const runner = {
      run: async () => ({}),
      quiesce: async () => {
        throw new Error('abort endpoint unreachable')
      },
    }
    expect(await quiesceAgent(runner, h)).toBe('unconfirmed')
  })
})

describe('workspaceIsolated', () => {
  const h: AgentHandle = { agentId: 'a1', workspacePath: '/w', baseUrl: '' }

  test('a sandbox that cannot answer is assumed to have co-tenants', () => {
    expect(workspaceIsolated(new MockSandbox(), h)).toBe(false)
  })

  test('a sandbox that throws is assumed to have co-tenants', () => {
    expect(workspaceIsolated({ isolatedWorkspace: () => { throw new Error('x') } }, h)).toBe(false)
  })

  test('takes the sandbox at its word when it claims isolation', () => {
    expect(workspaceIsolated({ isolatedWorkspace: () => true }, h)).toBe(true)
  })
})

describe('checkQuota', () => {
  test('passes a workspace under the limit', () => {
    expect(checkQuota([{ path: 'a', bytes: 100 }], { maxBytes: 1000, maxFiles: 10 }).ok).toBe(true)
  })

  test('fails a workspace over the byte limit', () => {
    const r = checkQuota([{ path: 'a', bytes: 5000 }], { maxBytes: 1000, maxFiles: 10 })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/bytes|size/i)
  })

  test('fails a workspace over the file-count limit', () => {
    const files = Array.from({ length: 50 }, (_, i) => ({ path: `f${i}`, bytes: 1 }))
    const r = checkQuota(files, { maxBytes: 1_000_000, maxFiles: 10 })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/files/i)
  })

  // Amendment (C): 500 files is ordinary work (an `npm install` alone exceeds it).
  test('the default file limit tolerates a dependency install', () => {
    expect(DEFAULT_CONFIG.maxWorkspaceFiles).toBe(2000)
    const files = Array.from({ length: 1500 }, (_, i) => ({ path: `node_modules/f${i}`, bytes: 10 }))
    expect(checkQuota(files, {
      maxBytes: DEFAULT_CONFIG.maxWorkspaceBytes,
      maxFiles: DEFAULT_CONFIG.maxWorkspaceFiles,
    }).ok).toBe(true)
  })
})
