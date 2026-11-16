import { networkInterfaces } from 'node:os'
import type { FastifyInstance } from 'fastify'

/**
 * The dashboard API has no authentication: it is meant for the person at this machine. That holds only if a web page
 * the browser happens to be showing cannot reach it. Two checks keep it that way:
 *
 * - **Host**: a DNS-rebinding page reaches 127.0.0.1 under its own hostname, so a request whose Host is not a name
 *   this server answers to is refused.
 * - **Origin**: a cross-site page can still send requests to 127.0.0.1 itself; browsers name the page in Origin, so a
 *   request carrying a foreign (or opaque `null`) Origin is refused.
 *
 * Ports are not compared: the Vite dev server proxies from another port, and the published port can differ in Docker.
 */

const LOOPBACK = ['localhost', '127.0.0.1', '::1']
const WILDCARD = new Set(['', '0.0.0.0', '::'])

/** Names the server answers to: loopback, the bind host, and every local address when it binds all of them. */
export function allowedHostsFor(bindHost?: string | null): ReadonlySet<string> {
  const allowed = new Set(LOOPBACK)
  const bind = (bindHost ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (WILDCARD.has(bind)) {
    if (bindHost != null) {
      for (const list of Object.values(networkInterfaces())) {
        for (const a of list ?? []) allowed.add(a.address.toLowerCase())
      }
    }
  } else {
    allowed.add(bind)
  }
  return allowed
}

function hostnameOf(value: string): string | null {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

export function isLocalRequest(headers: { host?: string | undefined; origin?: string | undefined }, allowed: ReadonlySet<string>): boolean {
  const host = headers.host ? hostnameOf(headers.host) : null
  if (!host || !allowed.has(host)) return false
  if (headers.origin === undefined) return true
  const origin = hostnameOf(headers.origin)
  return origin !== null && allowed.has(origin)
}

/** Refuses every request that is not from a page this server serves, before any route runs. */
export function registerLocalOriginGuard(app: FastifyInstance, allowed: ReadonlySet<string>): void {
  app.addHook('onRequest', async (req, reply) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    if (!isLocalRequest({ host: req.headers.host, origin }, allowed)) {
      return reply.code(403).send({ error: 'Refused: the dashboard answers only to pages it serves, on this machine.' })
    }
  })
}
