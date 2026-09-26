import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The real package throws outside the RSC graph. See the stub.
      'server-only': fileURLToPath(new URL('./src/allset/testing/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['src/allset/testing/global-setup.ts'],
    setupFiles: ['src/allset/testing/setup.ts'],
    // The compliance suite is an assertion about legality, not a flake budget.
    // No retries: a nondeterministic compliance test is a broken compliance test.
    retry: 0,
  },
});
