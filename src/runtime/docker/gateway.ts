import { GATEWAY_CPUS, GATEWAY_MEMORY } from './gateway-limits.js'
import { NETWORK_OWNER_LABEL } from './network.js'

export { GATEWAY_CPUS, GATEWAY_MEMORY, GATEWAY_MEMORY_BYTES } from './gateway-limits.js'

/**
 * One gateway container per protected shard: the only member of the shard's internal network
 * besides its worker, and the only one also on Docker's bridge.
 *
 * It exists because a container on an internal network cannot publish a port (verified,
 * docs/superpowers/specs/2026-09-15-protected-runtime-verified-facts.md). It carries exactly two
 * fixed routes and nothing else: the app to the worker's OpenCode API, and the worker to the
 * relay on the host's loopback. It holds no credential, takes no instructions from the worker,
 * and runs unprivileged on a read-only root.
 */

/** Published to the host on loopback; forwards to the worker's OpenCode server. */
export const GATEWAY_API_PORT = 14096

/** Where workers reach the relay: `http://gateway:8787`. */
export const GATEWAY_RELAY_PORT = 8787

export const GATEWAY_ALIAS = 'gateway'

const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/

export function gatewayName(runId: string, shardIndex: number): string {
  return `arena-${runId}-gw-${shardIndex}`
}

export function gatewayScript(relayPort: number): string {
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
    throw new Error(`relay port must be an integer from 1 to 65535, got ${relayPort}`)
  }
  return [
    "const net=require('net')",
    "const pipe=(port,host,target)=>net.createServer(c=>{const u=net.connect(target,host);c.pipe(u).pipe(c);u.on('error',()=>c.destroy());c.on('error',()=>u.destroy())}).listen(port)",
    `pipe(${GATEWAY_API_PORT},${JSON.stringify('worker')},4096)`,
    `pipe(${GATEWAY_RELAY_PORT},${JSON.stringify('host.docker.internal')},${relayPort})`,
  ].join(';')
}

export function buildGatewayRunArgs(spec: { runId: string; shardIndex: number; image: string; relayPort: number }): string[] {
  if (!SAFE_RUN_ID.test(spec.runId)) throw new Error(`unsafe run id for a gateway name: ${JSON.stringify(spec.runId)}`)
  return [
    'run', '-d', '--name', gatewayName(spec.runId, spec.shardIndex),
    '--label', NETWORK_OWNER_LABEL, '--label', `arena.run=${spec.runId}`,
    // Two TCP pipes need very little; the ceiling is charged to the run's capacity like any container.
    '-m', GATEWAY_MEMORY, '--memory-swap', GATEWAY_MEMORY, '--cpus', String(GATEWAY_CPUS), '--pids-limit', '64',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--user', '1000:1000',
    '-p', `127.0.0.1:0:${GATEWAY_API_PORT}`,
    spec.image, 'node', '-e', gatewayScript(spec.relayPort),
  ]
}
