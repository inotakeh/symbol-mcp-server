import { defineConfig } from 'vitest/config';

const integration = process.env.SYMBOL_INTEGRATION === '1';

export default defineConfig({
  test: {
    include: integration
      ? ['test/**/*.test.ts']
      : ['test/unit/**/*.test.ts', 'test/tools/**/*.test.ts', 'test/evals/**/*.test.ts'],
    testTimeout: integration ? 60_000 : 10_000,
    // Live-node tests must never run in CI; they are opt-in via SYMBOL_INTEGRATION=1.
    environment: 'node',
  },
});
