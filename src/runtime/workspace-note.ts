import { formatDiskSize, MIN_FILE_BYTES } from '../engine/capture.js'
import type { ToolboxPackages } from './toolbox.js'

/**
 * What every real agent's prompt says about its workspace: the disk it may use, and the packages
 * already installed for it (the shared toolbox locally, the image's copy in Docker). Agents that
 * were not told either installed a framework to test their code and scored 0 for the files.
 */
export function workspaceNote(opts: { diskLimitBytes: number; teamSize: number | null; packages: ToolboxPackages | null }): string {
  const minFile = formatDiskSize(MIN_FILE_BYTES)
  const disk = opts.teamSize !== null
    ? `Disk: the team's shared folder may use up to ${formatDiskSize(opts.diskLimitBytes * opts.teamSize)} (${formatDiskSize(opts.diskLimitBytes)} per member), each file counted as at least ${minFile}. Past that the round's work scores 0, so delete what you no longer need, such as packages you installed.`
    : `Disk: your workspace may use up to ${formatDiskSize(opts.diskLimitBytes)}, each file counted as at least ${minFile}. Past that your work scores 0, so delete what you no longer need, such as packages you installed.`
  const p = opts.packages
  if (!p || (p.python.length === 0 && p.node.length === 0)) return disk
  const installed = [
    ...(p.python.length > 0 ? [`\`python3\` with ${p.python.join(', ')}`] : []),
    ...(p.node.length > 0 ? [`the Node packages ${p.node.join(', ')}, which \`import\` finds from any folder here, with their commands (such as tsx, tsc and vitest) on PATH`] : []),
  ]
  return [
    disk,
    `Already installed for you, read-only: ${installed.join('; ')}. Use these instead of installing them.`,
    'To add a package, install it into your own folder: `python3 -m pip install --target .pylib <name>` and run with `PYTHONPATH=.pylib` for Python; `npm init -y` and then `npm install <name>` for Node.',
  ].join('\n')
}
