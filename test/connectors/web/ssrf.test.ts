import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { request } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import {
  BlockedTargetError,
  isBlockedAddress,
  parseTargetUrl,
  pinnedLookup,
  resolvePublicAddress,
  type LookupFn,
} from '../../../src/connectors/web/ssrf.js'

describe('address policy', () => {
  const blockedV4 = [
    '0.0.0.0', '0.1.2.3', // this network
    '10.0.0.1', '10.255.255.255', // private
    '100.64.0.1', '100.100.100.200', '100.127.255.255', // CGNAT, Alibaba metadata
    '127.0.0.1', '127.255.255.254', // loopback
    '169.254.169.254', '169.254.0.1', // link-local, cloud metadata
    '172.16.0.1', '172.31.255.255', // private
    '192.0.0.1', '192.0.0.192', '192.0.2.1', '192.88.99.1', // IETF, TEST-NET-1, 6to4 relay
    '192.168.1.1', // private
    '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', // benchmarking, TEST-NETs
    '224.0.0.1', '239.255.255.250', // multicast
    '240.0.0.1', '255.255.255.255', // reserved, broadcast
    '168.63.129.16', // Azure host endpoint (public range, metadata-like)
  ]
  const allowedV4 = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.255.255',
    '172.32.0.1', '192.167.1.1', '198.17.255.255', '198.20.0.1', '169.253.255.255', '223.255.255.255',
  ]
  const blockedV6 = [
    '::', '::1', 'fe80::1', 'fe80::1%lo0', 'fc00::1', 'fd00:ec2::254', 'fec0::1', 'ff02::1', 'ff05::1:3',
    '2001:db8::1', '2001::1', '2001:2::1', '100::1', '64:ff9b:1::1',
    // IPv4-mapped, in every spelling, judged by the embedded address
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:a9fe:a9fe', '::FFFF:10.0.0.1',
    // IPv4-compatible, NAT64 and 6to4 forms of blocked IPv4 addresses
    '::127.0.0.1', '::a9fe:a9fe', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '2002:a9fe:a9fe::1',
    '2002:c0a8:101::1',
  ]
  const allowedV6 = ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1']

  test.each(blockedV4)('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true))
  test.each(allowedV4)('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false))
  test.each(blockedV6)('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true))
  test.each(allowedV6)('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false))

  test('anything that is not an IP address is refused, not guessed at', () => {
    for (const bad of ['', 'localhost', '1.2.3', '1.2.3.4.5', '::g', '[::1]', '12345::1::2']) {
      expect(isBlockedAddress(bad)).toBe(true)
    }
  })
})

describe('target URLs', () => {
  test('http and https only, without credentials', () => {
    expect(parseTargetUrl('https://example.com/a?b=1').hostname).toBe('example.com')
    for (const bad of ['ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hi', 'not a url']) {
      expect(() => parseTargetUrl(bad)).toThrow(BlockedTargetError)
    }
    expect(() => parseTargetUrl('http://user:pass@example.com/')).toThrow(/credentials/)
    expect(() => parseTargetUrl(`https://example.com/${'a'.repeat(2100)}`)).toThrow(/2048/)
  })

  test('loopback names and every IPv4 spelling of loopback are refused before any lookup', async () => {
    const lookup: LookupFn = async () => { throw new Error('must not resolve') }
    for (const url of ['http://localhost/', 'http://LOCALHOST:8080/', 'http://api.localhost./', 'http://2130706433/', 'http://0x7f.1/', 'http://127.1/', 'http://[::1]/', 'http://[::ffff:7f00:1]/']) {
      const target = parseTargetUrl(url)
      await expect(resolvePublicAddress(target.hostname, lookup), url).rejects.toMatchObject({ code: expect.stringMatching(/^blocked_/) })
    }
  })
})

describe('resolution', () => {
  test('a public name resolves to its first answer', async () => {
    const lookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]
    await expect(resolvePublicAddress('example.com', lookup)).resolves.toEqual({ address: '93.184.216.34', family: 4 })
  })

  test('one private answer among public ones refuses the whole name', async () => {
    const lookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]
    await expect(resolvePublicAddress('mixed.example', lookup)).rejects.toMatchObject({ code: 'blocked_address' })
  })

  test('no answer, or a failed lookup, is a DNS failure', async () => {
    await expect(resolvePublicAddress('none.example', async () => [])).rejects.toMatchObject({ code: 'dns_failure' })
    await expect(resolvePublicAddress('gone.example', async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }))
      .rejects.toMatchObject({ code: 'dns_failure' })
  })

  test('an IP literal is judged without a lookup', async () => {
    const lookup: LookupFn = async () => { throw new Error('must not resolve') }
    await expect(resolvePublicAddress('8.8.8.8', lookup)).resolves.toEqual({ address: '8.8.8.8', family: 4 })
    await expect(resolvePublicAddress('[2606:4700:4700::1111]', lookup)).resolves.toEqual({ address: '2606:4700:4700::1111', family: 6 })
  })
})

describe('pinned lookup', () => {
  let close: (() => void) | null = null
  afterEach(() => { close?.(); close = null })

  test('a connection goes to the checked address whatever the host name would resolve to', async () => {
    const server = createServer((req, res) => res.end(`host=${req.headers.host}`))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    close = () => server.close()
    const port = (server.address() as AddressInfo).port
    // A name that cannot resolve: only the pinned lookup can make this connect.
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(`http://pinned.invalid:${port}/`, { agent: false, lookup: pinnedLookup('127.0.0.1', 4) }, (res) => {
        let text = ''
        res.on('data', (c: Buffer) => { text += c.toString() })
        res.on('end', () => resolve(text))
      })
      req.on('error', reject)
      req.end()
    })
    expect(body).toBe(`host=pinned.invalid:${port}`)
  })
})
