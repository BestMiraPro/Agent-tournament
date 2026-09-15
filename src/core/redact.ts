/**
 * Strips credentials an agent may have typed into a command before it is relayed or stored.
 * Defense in depth only: protected workers hold no provider credentials in the first place.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(authorization\s*[:=]\s*)[^"'\n]*/gi, '$1[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s"']+/gi, '$1$2[redacted]')
}
