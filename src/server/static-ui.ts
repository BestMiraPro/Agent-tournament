import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const NOT_BUILT = [
  '<!doctype html><meta charset="utf-8"><title>Agent Tournament</title>',
  '<body style="font-family:system-ui;background:#0a0e14;color:#e6e6e6;padding:2rem">',
  '<h1>The interface has not been built yet</h1>',
  '<p>Start the app with <code>npm start</code>, which builds it first, ',
  'or run <code>npm run web:build</code> and reload this page.</p>',
].join('')

/**
 * Serves the built UI from the dashboard's own port.
 *
 * The UI used to exist only behind the Vite dev server on a second port, proxying back to
 * this one — so using the app meant two terminals, two processes and a URL that was not
 * the API's. Serving the `vite build` output here makes it one process on one address,
 * which is what starting a normal app looks like. The dev server still works unchanged
 * for anyone editing the UI.
 *
 * Registered after the API, so every real route wins. Two rules keep the fallback honest:
 * an unmatched `/api/...` path stays a JSON 404 instead of quietly returning the page, and
 * a missing file with an extension is a 404 rather than the page — only extensionless
 * paths belong to the app itself.
 */
export function serveUi(app: FastifyInstance, dir: string): void {
  const root = resolve(dir)
  const indexPath = join(root, 'index.html')

  const sendIndex = async (reply: FastifyReply) => {
    try {
      const html = await readFile(indexPath)
      return reply.type(CONTENT_TYPES['.html']!).header('cache-control', 'no-cache').send(html)
    } catch {
      return reply.code(503).type(CONTENT_TYPES['.html']!).send(NOT_BUILT)
    }
  }

  const handle = async (raw: string, reply: FastifyReply) => {
    if (raw === 'api' || raw.startsWith('api/')) {
      return reply.code(404).send({ error: 'not found' })
    }

    let path: string
    try {
      path = decodeURIComponent(raw)
    } catch {
      return reply.code(400).send({ error: 'malformed path' })
    }
    if (path === '') return sendIndex(reply)

    // Decoded before the containment check, so `%2e%2e%2f` cannot walk out of the UI
    // directory after the check has passed on its encoded form.
    const target = resolve(root, path)
    if (target !== root && !target.startsWith(root + sep)) {
      return reply.code(404).send({ error: 'not found' })
    }

    try {
      if ((await stat(target)).isFile()) {
        const body = await readFile(target)
        const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
        // Vite fingerprints everything under assets/, so those names change whenever their
        // content does and can be cached for good. Anything else must be revalidated.
        const cache = path.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
        return reply.type(type).header('cache-control', cache).send(body)
      }
    } catch {
      /* not a file: fall through */
    }

    if (extname(path) !== '') return reply.code(404).send({ error: 'not found' })
    return sendIndex(reply)
  }

  app.get('/', async (_req, reply) => handle('', reply))
  app.get('/*', async (req, reply) => handle((req.params as { '*'?: string })['*'] ?? '', reply))
}
