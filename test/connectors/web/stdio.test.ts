import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { describe, expect, test } from 'vitest'

describe('stdio entrypoint', () => {
  test('serves the same two tools over stdio', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/connectors/web/stdio.ts'],
      // No keys: listing tools needs none, and nothing here may reach the network.
      env: { PATH: process.env.PATH ?? '' },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'stdio-test', version: '1.0.0' })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual(['web_fetch', 'web_search'])
    } finally {
      await client.close()
    }
  }, 30_000)
})
