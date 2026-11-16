import { createHash, randomBytes } from 'node:crypto'

/** A PKCE verifier and its S256 challenge (RFC 7636): 43 base64url characters of randomness. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** An unguessable OAuth `state`. */
export function oauthState(): string {
  return randomBytes(24).toString('base64url')
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/

/**
 * Where an OAuth provider sends the browser back: the dashboard's own origin, which works from `npm start` and from
 * the container image (published on host loopback) alike. Only a loopback Host is accepted: the dashboard has no
 * authentication and must not hand a provider a redirect to anywhere else.
 */
export function loopbackCallbackUrl(hostHeader: string | undefined, path: string): string {
  if (!hostHeader || !LOOPBACK_HOST.test(hostHeader)) {
    throw new Error('Sign-in can only be started from the dashboard on this machine (http://127.0.0.1 or http://localhost).')
  }
  return `http://${hostHeader}${path}`
}
