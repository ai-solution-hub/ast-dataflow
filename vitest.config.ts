import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './'),
    },
  },
  test: {
    environment: 'node',
    include: ['tools/**/*.test.ts'],
    globals: true,
    pool: 'forks',
    // ts-morph project loads in cold-start tests can exceed the 10s default.
    hookTimeout: 30_000,
  },
});
