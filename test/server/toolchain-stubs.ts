import { vi } from 'vitest'
import { CapacityLedger } from '../../src/runtime/docker/capacity.js'
import type { ImageInventory } from '../../src/runtime/tool-manifest.js'

/** A toolchain identity and a valid image inventory, so docker compositions never ask a real daemon. */
export const STUB_TOOLCHAIN_ID = 'abc123def4567890'

export const stubInventory = (): ImageInventory => ({
  schemaVersion: 1,
  toolchainId: STUB_TOOLCHAIN_ID,
  python: { version: '3.11.2', venv: '/opt/arena/venv', executable: '/opt/arena/venv/bin/python' },
  tools: ['python3', 'node', 'git', 'opencode'].map((name) => ({ name, version: '1.0', executable: `/usr/bin/${name}` })),
  pythonPackages: [{ name: 'numpy', version: '2.3.3' }],
})

export const toolchainSeams = () => ({
  toolchainId: vi.fn(async () => STUB_TOOLCHAIN_ID),
  readImageInventory: vi.fn(async () => stubInventory()),
  // A private ledger, so no test leaves capacity reserved in the process-wide one.
  ledger: new CapacityLedger(),
})
