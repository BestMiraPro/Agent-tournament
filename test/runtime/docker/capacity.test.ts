import { describe, expect, test } from 'vitest'
import { CapacityLedger, parseMemoryLimit, planCapacity, readHostCapacity } from '../../../src/runtime/docker/capacity.js'
import type { DockerFn, ExecResult } from '../../../src/runtime/docker/cli.js'

describe('CapacityLedger', () => {
  const GiB = 1024 ** 3
  const host = (usedBytes = 0, containers: { name: string; usedBytes: number }[] = []) => ({
    totalMemoryBytes: 5 * GiB, usedMemoryBytes: usedBytes, cpus: 16, containers,
  })
  const req = (containers: number) => ({ containers, memoryBytes: GiB, cpus: 1 })

  test('two starts that together exceed the budget cannot both be admitted', () => {
    const ledger = new CapacityLedger()
    // 5GiB total, 80% committable: 4GiB. 3GiB fits; another 2GiB does not.
    expect(ledger.admit('run-a', req(3), host()).ok).toBe(true)
    const second = ledger.admit('run-b', req(2), host())
    expect(second.ok).toBe(false)
    expect(second.reason).toMatch(/3\.00GiB is already reserved by other runs in this app/)
    expect(ledger.active().map((r) => r.id)).toEqual(['run-a'])
  })

  test('a running reservation is not counted twice: its observed usage is inside its ceiling', () => {
    const ledger = new CapacityLedger()
    expect(ledger.admit('run-a', req(2), host()).ok).toBe(true)
    ledger.attach('run-a', 'arena-a-0')
    ledger.attach('run-a', 'arena-a-1')
    // run-a's two containers use 1.5GiB; an unrelated container uses 0.5GiB.
    const observed = host(2 * GiB, [
      { name: 'arena-a-0', usedBytes: 0.75 * GiB },
      { name: 'arena-a-1', usedBytes: 0.75 * GiB },
      { name: 'other', usedBytes: 0.5 * GiB },
    ])
    // Budget 0.8 x (5 - 0.5) = 3.6GiB; 2GiB reserved leaves 1.6GiB: one more 1GiB container fits.
    expect(ledger.admit('run-b', req(1), observed).ok).toBe(true)
    expect(ledger.admit('run-c', req(1), observed).ok).toBe(false)
  })

  test('a run re-admitted to grow does not count its own running containers twice', () => {
    const ledger = new CapacityLedger()
    expect(ledger.admit('run-a', req(2), host()).ok).toBe(true)
    ledger.attach('run-a', 'arena-a-0')
    ledger.attach('run-a', 'arena-a-1')
    // Its two containers use 1.5GiB of the 5GiB. Growing to 4 containers needs 4GiB, which is
    // exactly the 0.8 x 5GiB budget once its own usage is recognised as inside its ceilings;
    // counting that usage as foreign too left 2.8GiB and refused the growth.
    const running = host(1.5 * GiB, [
      { name: 'arena-a-0', usedBytes: 0.75 * GiB },
      { name: 'arena-a-1', usedBytes: 0.75 * GiB },
    ])
    expect(ledger.admit('run-a', req(4), running).ok).toBe(true)
    expect(ledger.admit('run-a', req(5), running).ok).toBe(false)
  })

  test('release is idempotent and leaves other reservations counted', () => {
    const ledger = new CapacityLedger()
    ledger.admit('run-a', req(2), host())
    ledger.admit('run-b', req(1), host())
    ledger.release('run-b')
    ledger.release('run-b')
    expect(ledger.active().map((r) => r.id)).toEqual(['run-a'])
    expect(ledger.admit('run-c', req(3), host()).ok).toBe(false)
    expect(ledger.admit('run-c', req(2), host()).ok).toBe(true)
  })

  test('re-admitting an id resizes its reservation instead of stacking a second one', () => {
    const ledger = new CapacityLedger()
    ledger.admit('run-a', req(2), host())
    expect(ledger.admit('run-a', req(4), host()).ok).toBe(true)
    expect(ledger.active()).toEqual([{ id: 'run-a', containers: 4, memoryBytes: GiB, cpus: 1 }])
    expect(ledger.admit('run-a', req(5), host()).ok).toBe(false)
    expect(ledger.active()[0]!.containers).toBe(4)
  })

  test('CPU ceilings of other reservations count too', () => {
    const ledger = new CapacityLedger()
    const roomy = { totalMemoryBytes: 64 * GiB, usedMemoryBytes: 0, cpus: 4, containers: [] }
    expect(ledger.admit('run-a', { containers: 3, memoryBytes: GiB, cpus: 1 }, roomy).ok).toBe(true)
    const r = ledger.admit('run-b', { containers: 2, memoryBytes: GiB, cpus: 1 }, roomy)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/CPUs per container/)
  })
})

describe('parseMemoryLimit', () => {
  test('parses megabytes and gigabytes', () => {
    expect(parseMemoryLimit('512m')).toBe(512 * 1024 * 1024)
    expect(parseMemoryLimit('1g')).toBe(1024 * 1024 * 1024)
    expect(parseMemoryLimit('2G')).toBe(2 * 1024 * 1024 * 1024)
  })

  test('throws on an unparseable limit', () => {
    expect(() => parseMemoryLimit('lots')).toThrow(/memory/i)
  })
})

describe('planCapacity', () => {
  const host = { totalMemoryBytes: 6.69 * 1024 ** 3, usedMemoryBytes: 1.5 * 1024 ** 3, cpus: 16 }

  test('accepts a plan that fits comfortably', () => {
    const r = planCapacity({ containers: 4, memory: '1g', cpus: 1 }, host)
    expect(r.ok).toBe(true)
  })

  test('rejects a plan that exceeds available memory', () => {
    const r = planCapacity({ containers: 20, memory: '1g', cpus: 1 }, host)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/memory/i)
  })

  test('rejects a plan that oversubscribes CPUs', () => {
    const r = planCapacity({ containers: 4, memory: '256m', cpus: 8 }, host)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/cpu/i)
  })

  test('reserves headroom rather than consuming every last byte', () => {
    // 5.19GiB free; 5 x 1g would fit arithmetically but leaves nothing for the host.
    const r = planCapacity({ containers: 5, memory: '1g', cpus: 1 }, host)
    expect(r.ok).toBe(false)
  })

  test('suggests the largest container count that would fit', () => {
    const r = planCapacity({ containers: 20, memory: '1g', cpus: 1 }, host)
    expect(r.suggestedContainers).toBeGreaterThan(0)
    expect(r.suggestedContainers).toBeLessThan(20)
  })

  test.each([
    ['unreadable total memory', { totalMemoryBytes: NaN, usedMemoryBytes: 0, cpus: 16 }],
    ['unreadable cpu count', { totalMemoryBytes: 16 * 1024 ** 3, usedMemoryBytes: 0, cpus: NaN }],
    ['unreadable usage', { totalMemoryBytes: 16 * 1024 ** 3, usedMemoryBytes: NaN, cpus: 16 }],
  ])('refuses rather than approves a plan against %s', (_name, broken) => {
    // Every comparison against NaN is false, so an absurd plan sailed through BOTH
    // guards and came back ok — the overcommit preflight silently approving the exact
    // thing it exists to stop. Fail closed instead.
    const r = planCapacity({ containers: 500, memory: '8g', cpus: 8 }, broken)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/capacity/i)
  })
})

describe('readHostCapacity', () => {
  const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 })

  /** Answers `docker info` and `docker stats` from canned results, in call order. */
  const fakeDocker = (info: ExecResult, stats: ExecResult = ok('')): DockerFn =>
    async (args) => (args[0] === 'info' ? info : stats)

  test('reads total memory, usage and cpus from a healthy daemon', async () => {
    const host = await readHostCapacity(
      fakeDocker(ok('17179869184|16'), ok('512MiB / 1GiB\n1.5GiB / 2GiB\n')),
    )
    expect(host.totalMemoryBytes).toBe(17_179_869_184)
    expect(host.cpus).toBe(16)
    expect(host.usedMemoryBytes).toBe(512 * 1024 ** 2 + 1.5 * 1024 ** 3)
  })

  test('attributes usage to containers by name', async () => {
    const calls: string[][] = []
    const docker: DockerFn = async (args) => {
      calls.push(args)
      return args[0] === 'info' ? ok('17179869184|16') : ok('arena-r-0|512MiB / 1GiB\nother|1.5GiB / 2GiB\n')
    }
    const host = await readHostCapacity(docker)
    expect(calls[1]).toEqual(['stats', '--no-stream', '--format', '{{.Name}}|{{.MemUsage}}'])
    expect(host.containers).toEqual([
      { name: 'arena-r-0', usedBytes: 512 * 1024 ** 2 },
      { name: 'other', usedBytes: 1.5 * 1024 ** 3 },
    ])
    expect(host.usedMemoryBytes).toBe(512 * 1024 ** 2 + 1.5 * 1024 ** 3)
  })

  test('a host with no containers running reports zero usage, not a failure', async () => {
    const host = await readHostCapacity(fakeDocker(ok('17179869184|16'), ok('')))
    expect(host.usedMemoryBytes).toBe(0)
    expect(host.totalMemoryBytes).toBe(17_179_869_184)
  })

  test('a daemon that is not running is surfaced, not read as an empty host', async () => {
    // Exit status was never checked, so a dead daemon became totalMemoryBytes 0 and the
    // preflight refused the run for "not enough memory" — the wrong reason entirely.
    await expect(readHostCapacity(
      fakeDocker({ stdout: '', stderr: 'Cannot connect to the Docker daemon', code: 1 }),
    )).rejects.toThrow(/daemon|docker info/i)
  })

  test.each([['abc|def'], ['|'], ['17179869184'], ['0|16'], ['17179869184|0']])(
    'malformed info output %j is surfaced rather than silently trusted',
    async (stdout) => {
      // NaN or 0 here is what made planCapacity approve an absurd plan.
      await expect(readHostCapacity(fakeDocker(ok(stdout)))).rejects.toThrow(/capacity|memory|cpu/i)
    },
  )

  test('a failed stats call is surfaced rather than read as zero usage', async () => {
    // Assuming nothing is running when we could not ask is the over-committing
    // direction: it makes every already-running container invisible to the budget.
    await expect(readHostCapacity(
      fakeDocker(ok('17179869184|16'), { stdout: '', stderr: 'daemon gone', code: 1 }),
    )).rejects.toThrow(/usage|docker stats/i)
  })
})

describe('planCapacity refusal wording', () => {
  // The exact reading from an operator's machine: Docker Desktop at 6.69GiB with other
  // projects' containers using about 4.18GiB of it.
  const shared = { totalMemoryBytes: 7_182_827_520, usedMemoryBytes: 7_182_827_520 - 2.51 * 1024 ** 3, cpus: 16 }

  test('suggests only things the operator can actually change', () => {
    // It used to say "Reduce maxContainers, lower containerMemory" — neither of which the
    // dashboard exposed, so the advice could not be followed from the app at all.
    const r = planCapacity({ containers: 4, memory: '1g', cpus: 1 }, shared)
    expect(r.ok).toBe(false)
    expect(r.suggestedContainers).toBe(2)
    expect(r.reason).toMatch(/Lower the container count to 2/)
    expect(r.reason).toMatch(/memory per container/)
    expect(r.reason).toMatch(/stop Docker containers you are not using/)
    expect(r.reason).toMatch(/Docker Desktop's memory limit/)
  })

  test('never suggests lowering the container count to zero', () => {
    const r = planCapacity({ containers: 1, memory: '4g', cpus: 1 }, shared)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/Not even one container/)
    expect(r.reason).not.toMatch(/count to 0/)
    // Each branch must read as a sentence on its own: the first version of this message
    // ran "...Docker has free. lower the memory..." into the shared tail.
    expect(r.reason).toMatch(/free\. Lower the memory per container/)
  })

  test('a CPU refusal says what to lower', () => {
    const roomy = { totalMemoryBytes: 64 * 1024 ** 3, usedMemoryBytes: 0, cpus: 16 }
    const r = planCapacity({ containers: 4, memory: '256m', cpus: 8 }, roomy)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/CPUs per container/)
  })
})
