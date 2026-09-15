import { vi } from 'vitest'
import { CapacityLedger } from '../../src/runtime/docker/capacity.js'
import { RelayPolicy } from '../../src/runtime/provider-relay.js'
import type { ImageInventory } from '../../src/runtime/tool-manifest.js'

/** A toolchain identity and a valid image inventory, so docker compositions never ask a real daemon. */
export const STUB_TOOLCHAIN_ID = 'abc123def4567890'

export const stubInventory = (): ImageInventory => ({
  schemaVersion: 1,
  toolchainId: STUB_TOOLCHAIN_ID,
  python: { version: '3.11.2', venv: '/opt/arena/venv', executable: '/opt/arena/venv/bin/python' },
  tools: ['python3', 'node', 'git', 'opencode', 'rg'].map((name) => ({ name, version: '1.0', executable: `/usr/bin/${name}` })),
  pythonPackages: [{ name: 'numpy', version: '2.3.3' }],
})

export const toolchainSeams = () => ({
  toolchainId: vi.fn(async () => STUB_TOOLCHAIN_ID),
  readImageInventory: vi.fn(async () => stubInventory()),
  // A private ledger, so no test leaves capacity reserved in the process-wide one.
  ledger: new CapacityLedger(),
  // The protected runtime's host side, faked: no real credentials file, catalogue, relay or networks.
  hostModelsFile: vi.fn(() => '/host/models.json'),
  readTextFile: vi.fn(async (path: string) =>
    path.endsWith('models.json')
      ? JSON.stringify({ w: { api: 'https://api.w.example/v1', npm: '@ai-sdk/openai-compatible', models: {} } })
      : JSON.stringify({ w: { type: 'api', key: 'FAKE-W-KEY' } })),
  relay: vi.fn(async () => ({ policy: new RelayPolicy(), port: 45678 })),
  createShardNetworkFn: vi.fn(async (runId: string, shardIndex: number) => `arena-${runId}-net-${shardIndex}`),
  removeShardNetworkFn: vi.fn(async (_name: string, _onWarning?: (message: string) => void) => true),
})
