import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The compliance suite is an assertion about legality, not a flake budget.
    // No retries: a nondeterministic compliance test is a broken compliance test.
    retry: 0,
  },
});
