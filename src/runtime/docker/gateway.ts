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
 * relay — on the host's loopback, or at the app's bridge address when the app itself runs in a
 * container. It holds no credential, takes no instructions from the worker, and runs
 * unprivileged on a read-only root.
 */

/** Published to the host on loopback; forwards to the worker's OpenCode server. */
export const GATEWAY_API_PORT = 14096

/** Where workers reach the relay: `http://gateway:8787`. */
export const GATEWAY_RELAY_PORT = 8787

export const GATEWAY_ALIAS = 'gateway'

/**
 * Where a protected worker's Claude Code CLI finds its one way out: an HTTP CONNECT proxy on the
 * gateway that tunnels to exactly `ANTHROPIC_EGRESS_TARGET`. Started only for runs with Claude
 * subscription agents. (8788 is the connectors route on another branch.)
 */
export const GATEWAY_EGRESS_PORT = 8789

/** The only CONNECT target the egress route accepts; Claude Code 2.1.325 contacts nothing else. */
export const ANTHROPIC_EGRESS_TARGET = 'api.anthropic.com:443'

/** Where gateways forward model calls when the app runs on the Docker host. */
export const HOST_RELAY_ADDRESS = 'host.docker.internal'

const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/
/** A hostname or an IPv4 address: nothing that could change the forwarder's meaning. */
const SAFE_RELAY_HOST = /^[A-Za-z0-9.-]+$/

export function gatewayName(runId: string, shardIndex: number): string {
  return `arena-${runId}-gw-${shardIndex}`
}

/**
 * The egress route's source: a CONNECT proxy that compares the target with
 * `ANTHROPIC_EGRESS_TARGET` byte for byte, so other hosts, other ports, IP literals, case or
 * trailing-dot variants are all refused (403), and so is every method but CONNECT (405). The
 * tunnel dials the allowed host itself, never anything parsed from the request. `upstream` is where
 * that dial goes; only tests point it elsewhere.
 */
export function egressProxyScript(port: number, upstream: { host: string; port: number } = { host: 'api.anthropic.com', port: 443 }): string {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`egress port must be an integer from 0 to 65535, got ${port}`)
  if (!SAFE_RELAY_HOST.test(upstream.host) || !Number.isInteger(upstream.port)) throw new Error('unsafe egress upstream')
  // Names prefixed with egress so this route can sit beside the others in one script.
  return [
    "const egressHttp=require('http'),egressNet=require('net')",
    `const egressTarget=${JSON.stringify(ANTHROPIC_EGRESS_TARGET)}`,
    "const egress=egressHttp.createServer((q,r)=>{r.writeHead(405,{connection:'close'});r.end()})",
    "egress.on('connect',(q,c,h)=>{c.on('error',()=>c.destroy());if(q.method!=='CONNECT'||q.url!==egressTarget){c.end('HTTP/1.1 403 Forbidden\\r\\n\\r\\n');return}" +
      `const u=egressNet.connect(${upstream.port},${JSON.stringify(upstream.host)},()=>{c.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');if(h&&h.length)u.write(h);u.pipe(c).pipe(u)});u.on('error',()=>c.destroy());c.on('close',()=>u.destroy())})`,
    "egress.on('clientError',(e,s)=>s.destroy())",
    `egress.listen(${port})`,
  ].join(';')
}

export function gatewayScript(relayPort: number, relayHost: string = HOST_RELAY_ADDRESS, opts: { claudeEgress?: boolean } = {}): string {
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
    throw new Error(`relay port must be an integer from 1 to 65535, got ${relayPort}`)
  }
  if (!SAFE_RELAY_HOST.test(relayHost)) throw new Error(`unsafe relay host: ${JSON.stringify(relayHost)}`)
  return [
    "const net=require('net')",
    "const pipe=(port,host,target)=>net.createServer(c=>{const u=net.connect(target,host);c.pipe(u).pipe(c);u.on('error',()=>c.destroy());c.on('error',()=>u.destroy())}).listen(port)",
    `pipe(${GATEWAY_API_PORT},${JSON.stringify('worker')},4096)`,
    `pipe(${GATEWAY_RELAY_PORT},${JSON.stringify(relayHost)},${relayPort})`,
    ...(opts.claudeEgress ? [egressProxyScript(GATEWAY_EGRESS_PORT)] : []),
  ].join(';')
}

export function buildGatewayRunArgs(spec: {
  runId: string
  shardIndex: number
  image: string
  relayPort: number
  /** Where the relay listens; the host's, through Docker's host alias, when unset. */
  relayHost?: string
  /** Adds the CONNECT route to api.anthropic.com for Claude subscription agents. */
  claudeEgress?: boolean
}): string[] {
  if (!SAFE_RUN_ID.test(spec.runId)) throw new Error(`unsafe run id for a gateway name: ${JSON.stringify(spec.runId)}`)
  return [
    'run', '-d', '--name', gatewayName(spec.runId, spec.shardIndex),
    '--label', NETWORK_OWNER_LABEL, '--label', `arena.run=${spec.runId}`,
    // Two TCP pipes need very little; the ceiling is charged to the run's capacity like any container.
    '-m', GATEWAY_MEMORY, '--memory-swap', GATEWAY_MEMORY, '--cpus', String(GATEWAY_CPUS), '--pids-limit', '64',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--user', '1000:1000',
    '-p', `127.0.0.1:0:${GATEWAY_API_PORT}`,
    spec.image, 'node', '-e', gatewayScript(spec.relayPort, spec.relayHost, { claudeEgress: spec.claudeEgress }),
  ]
}
