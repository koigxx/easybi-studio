import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    passWithNoTests: true,
    include: ['**/src/**/*.test.ts', '**/src/**/*.test.tsx', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'vendor/**'],
  },
});
