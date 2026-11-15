import { spawn, type ChildProcess } from 'node:child_process'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  ANTHROPIC_EGRESS_TARGET,
  buildGatewayRunArgs,
  egressProxyScript,
  GATEWAY_EGRESS_PORT,
  gatewayScript,
} from '../../../src/runtime/docker/gateway.js'

/** A free local port, so the real egress script can be run as the gateway runs it. */
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

/** Sends raw bytes to the proxy and returns the first response line, or what came back on the tunnel. */
function exchange(port: number, request: string, afterConnect?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let data = ''
    let sentTunnel = false
    socket.on('data', (d) => {
      data += d.toString()
      if (afterConnect && !sentTunnel && data.includes('\r\n\r\n') && data.startsWith('HTTP/1.1 200')) {
        sentTunnel = true
        data = ''
        socket.write(afterConnect)
        return
      }
      if (!afterConnect || sentTunnel) {
        if (afterConnect ? data.length >= afterConnect.length : data.includes('\r\n')) {
          socket.destroy()
          resolve(afterConnect ? data : data.split('\r\n')[0]!)
        }
      }
    })
    socket.on('close', () => resolve(afterConnect ? data : data.split('\r\n')[0] ?? ''))
    socket.on('error', reject)
    socket.write(request)
  })
}

describe('gateway egress route for Claude Code', () => {
  let proxy: ChildProcess
  let port: number
  let echo: Server
  let echoed = 0

  beforeAll(async () => {
    // The tunnel's far end: a local echo server stands in for api.anthropic.com:443.
    echo = createServer((s) => { echoed++; s.pipe(s) })
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
    port = await freePort()
    proxy = spawn(process.execPath, ['-e', egressProxyScript(port, { host: '127.0.0.1', port: (echo.address() as AddressInfo).port })], { stdio: 'ignore' })
    for (let i = 0; i < 50; i++) {
      const up = await new Promise<boolean>((r) => { const s = connect(port, '127.0.0.1', () => { s.destroy(); r(true) }); s.on('error', () => r(false)) })
      if (up) break
      await new Promise((r) => setTimeout(r, 50))
    }
  })

  afterAll(async () => {
    proxy.kill()
    await new Promise<void>((r) => echo.close(() => r()))
  })

  test('tunnels exactly CONNECT api.anthropic.com:443, both ways', async () => {
    const reply = await exchange(port, `CONNECT ${ANTHROPIC_EGRESS_TARGET} HTTP/1.1\r\nHost: ${ANTHROPIC_EGRESS_TARGET}\r\n\r\n`, 'tls-bytes')
    expect(reply).toBe('tls-bytes')
    expect(echoed).toBe(1)
  })

  test.each([
    ['another host', 'example.com:443'],
    ['a look-alike host', 'api.anthropic.com.evil.example:443'],
    ['another Anthropic host', 'statsig.anthropic.com:443'],
    ['another port', 'api.anthropic.com:80'],
    ['no port', 'api.anthropic.com'],
    ['an IPv4 literal', '160.79.104.10:443'],
    ['an IPv6 literal', '[2607:6bc0::10]:443'],
    ['loopback', '127.0.0.1:443'],
    ['a trailing dot', 'api.anthropic.com.:443'],
    ['different case', 'API.ANTHROPIC.COM:443'],
    ['a userinfo trick', 'api.anthropic.com:443@example.com:443'],
  ])('refuses CONNECT to %s', async (_label, target) => {
    expect(await exchange(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)).toBe('HTTP/1.1 403 Forbidden')
  })

  test.each(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'])('refuses %s, even for the allowed host', async (method) => {
    const res = await exchange(port, `${method} https://api.anthropic.com/v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Length: 0\r\n\r\n`)
    expect(res).toBe('HTTP/1.1 405 Method Not Allowed')
  })

  test('nothing refused ever reached the far end', () => {
    expect(echoed).toBe(1)
  })
})

describe('gateway with and without the egress route', () => {
  test('the route exists only when asked for, on its own port beside the two pipes', () => {
    expect(gatewayScript(41234)).not.toContain('egress')
    const withEgress = gatewayScript(41234, undefined, { claudeEgress: true })
    expect(withEgress).toContain('pipe(14096,"worker",4096)')
    expect(withEgress).toContain('pipe(8787,"host.docker.internal",41234)')
    expect(withEgress).toContain(`egress.listen(${GATEWAY_EGRESS_PORT})`)
    expect(withEgress).toContain(`const egressTarget=${JSON.stringify('api.anthropic.com:443')}`)
    expect(GATEWAY_EGRESS_PORT).not.toBe(8787)
    expect(GATEWAY_EGRESS_PORT).not.toBe(8788)
    // The whole script still parses as one program.
    expect(() => new Function(withEgress)).not.toThrow()
    const args = buildGatewayRunArgs({ runId: 'r', shardIndex: 0, image: 'agent-arena:tc-x', relayPort: 41234, claudeEgress: true })
    expect(args.at(-1)).toBe(withEgress)
    // Still nothing published but the worker API.
    expect(args.filter((a) => a === '-p')).toHaveLength(1)
  })
})
