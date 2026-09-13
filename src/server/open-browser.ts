import { execFile } from 'node:child_process'

type Run = (file: string, args: string[], options: { windowsHide: boolean }, callback: (error: Error | null) => void) => unknown

/**
 * Only our own loopback address is ever handed to the OS. The URL becomes an argument to a
 * system launcher, so accepting arbitrary strings here would turn "open the app" into
 * "open whatever this string names".
 */
function assertLocalAppUrl(url: string): void {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/?$/.test(url)) {
    throw new Error(`refusing to open a non-local URL: ${url}`)
  }
}

/** The platform's own "open this in the default browser" launcher. No shell is involved. */
export function browserCommand(url: string, platform: NodeJS.Platform): { file: string; args: string[] } {
  assertLocalAppUrl(url)
  // rundll32's URL handler goes straight to the default browser; `start` would need a
  // shell, and explorer.exe treats some URLs as paths.
  if (platform === 'win32') return { file: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  if (platform === 'darwin') return { file: 'open', args: [url] }
  return { file: 'xdg-open', args: [url] }
}

/**
 * Opens the app in the default browser, best effort.
 *
 * Never throws: the server is already running and the URL has been printed, so a machine
 * without a desktop browser — or a launcher that fails — must not take the app down.
 */
export function openBrowser(
  url: string,
  onFailure: (message: string) => void = () => {},
  run: Run = execFile as unknown as Run,
  platform: NodeJS.Platform = process.platform,
): void {
  try {
    const { file, args } = browserCommand(url, platform)
    run(file, args, { windowsHide: true }, (error) => {
      if (error) onFailure(`could not open a browser (${error.message}); open ${url} yourself`)
    })
  } catch (e) {
    onFailure(`could not open a browser (${(e as Error).message}); open ${url} yourself`)
  }
}

/**
 * Whether a dashboard is already answering at this address.
 *
 * Starting the app a second time should behave like any other app — bring up the one that
 * is already running — rather than fail with EADDRINUSE. But a port can be held by
 * something else entirely, so "in use" alone is not enough to decide it is ours: the API
 * has to answer with its own run-list shape. Never throws.
 */
export async function probeDashboard(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/runs`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return false
    const body = (await res.json()) as { runs?: unknown }
    return Array.isArray(body.runs)
  } catch {
    return false
  }
}
