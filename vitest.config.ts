import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // Local compositions would otherwise build the shared agent toolbox, downloading packages.
    env: { ARENA_TOOLBOX: 'off' },
  },
})
