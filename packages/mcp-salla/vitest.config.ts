import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // cli.ts and stdio.ts are thin process entry points (process.exit, real stdio pipes).
      // Their logic lives in args.ts and readStdioToken(), which are unit-tested.
      exclude: ['src/cli.ts', 'src/stdio.ts'],
      reporter: ['text', 'html'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
