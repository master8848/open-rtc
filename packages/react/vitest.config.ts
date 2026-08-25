import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve @vidcall/* workspace packages to their raw TS sources via the
    // `development` export condition (mirrors the root node --tests trick).
    conditions: ['development'],
  },
  test: {
    environment: 'jsdom',
  },
});
