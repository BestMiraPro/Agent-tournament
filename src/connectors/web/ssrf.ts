import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP, isIPv4, type LookupFunction } from 'node:net'

/**
 * Where `web_fetch` may connect. Agents choose the URL, so the host must never become a way into
 * its own loopback, the LAN, a container network or a cloud metadata service.
 *
 * The rule is on addresses, not names: a name is resolved once per hop, every answer must be
 * public, and the connection is pinned to the checked answer (`pinnedLookup`), so a second
 * resolution cannot rebind it. IPv6 forms that embed an IPv4 address (mapped, compatible, NAT64,
 * 6to4) are judged by that address. Anything that does not parse as an address is refused.
 */

export type BlockedCode = 'invalid_url' | 'blocked_host' | 'blocked_address' | 'dns_failure'

export class BlockedTargetError extends Error {
  constructor(public readonly code: BlockedCode, message: string) {
    super(message)
    this.name = 'BlockedTargetError'
  }
}

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

/** Every address a name resolves to, in resolver order. */
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>

export const systemLookup: LookupFn = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, order: 'verbatim' })
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }))
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  // Azure's host endpoint (WireServer): a public address that answers only from inside Azure.
  ['168.63.129.16', 32],
]

const V6_BLOCKED: [string, number][] = [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['64:ff9b:1::', 48],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]

const v4List = new BlockList()
for (const [net, prefix] of V4_BLOCKED) v4List.addSubnet(net, prefix, 'ipv4')
const v6List = new BlockList()
for (const [net, prefix] of V6_BLOCKED) v6List.addSubnet(net, prefix, 'ipv6')

/** Sixteen bytes for a valid IPv6 literal (no zone), or null. */
function ipv6Bytes(ip: string): number[] | null {
  if (isIP(ip) !== 6 || ip.includes('%')) return null
  let text = ip.toLowerCase()
  let tail: number[] = []
  const lastColon = text.lastIndexOf(':')
  const last = text.slice(lastColon + 1)
  if (last.includes('.')) {
    tail = last.split('.').map(Number)
    text = `${text.slice(0, lastColon + 1)}0:0`
  }
  const [head, rest] = text.split('::') as [string, string | undefined]
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((h) => parseInt(h, 16)))
  const left = parse(head)
  const right = rest === undefined ? [] : parse(rest)
  const groups = rest === undefined ? left : [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right]
  if (groups.length !== 8) return null
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff])
  if (tail.length === 4) bytes.splice(12, 4, ...tail)
  return bytes
}

/** The IPv4 address an IPv6 address carries by construction, or null. */
function embeddedIPv4(bytes: number[]): string | null {
  const zero = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0)
  const v4 = (at: number) => bytes.slice(at, at + 4).join('.')
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible; :: and ::1 are caught before this).
  if (zero(0, 10) && ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0))) return v4(12)
  // 64:ff9b::a.b.c.d (NAT64 well-known prefix).
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)) return v4(12)
  // 2002:aabb:ccdd::/48 (6to4).
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return v4(2)
  return null
}

/** True when `ip` is not a public unicast address, or is not an address at all. */
export function isBlockedAddress(ip: string): boolean {
  if (isIPv4(ip)) return v4List.check(ip, 'ipv4')
  const bytes = ipv6Bytes(ip)
  if (!bytes) return true
  if (v6List.check(ip.toLowerCase(), 'ipv6')) return true
  const v4 = embeddedIPv4(bytes)
  return v4 !== null && v4List.check(v4, 'ipv4')
}

export const MAX_URL_LENGTH = 2048

/** A URL `web_fetch` may request: http(s), no credentials, bounded length. */
export function parseTargetUrl(raw: string): URL {
  if (raw.length > MAX_URL_LENGTH) throw new BlockedTargetError('invalid_url', `URLs are limited to ${MAX_URL_LENGTH} characters`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BlockedTargetError('invalid_url', 'not a valid absolute URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedTargetError('invalid_url', 'only http and https URLs can be fetched')
  }
  if (url.username || url.password) throw new BlockedTargetError('invalid_url', 'URLs with credentials are not fetched')
  return url
}

/**
 * The one address a hop connects to. IP literals are judged directly; names are resolved once and
 * refused when any answer is blocked, so a name cannot mix a public and a private answer.
 */
export async function resolvePublicAddress(hostname: string, lookup: LookupFn): Promise<ResolvedAddress> {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  const family = isIP(host)
  if (family !== 0) {
    if (isBlockedAddress(host)) throw new BlockedTargetError('blocked_address', 'that address is not on the public internet')
    return { address: host, family: family === 6 ? 6 : 4 }
  }
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) {
    throw new BlockedTargetError('blocked_host', 'local host names are not fetched')
  }
  let answers: ResolvedAddress[]
  try {
    answers = await lookup(host)
  } catch {
    throw new BlockedTargetError('dns_failure', 'the host name did not resolve')
  }
  if (answers.length === 0) throw new BlockedTargetError('dns_failure', 'the host name did not resolve')
  if (answers.some((a) => isBlockedAddress(a.address))) {
    throw new BlockedTargetError('blocked_address', 'the host name resolves to an address that is not on the public internet')
  }
  return answers[0]!
}

/** A socket `lookup` that answers only with the address already checked. */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if ((options as { all?: boolean } | undefined)?.all) {
      ;(callback as unknown as (err: null, addresses: { address: string; family: number }[]) => void)(null, [{ address, family }])
    } else {
      callback(null, address, family)
    }
  }
}
