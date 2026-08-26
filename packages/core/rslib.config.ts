import { defineConfig } from '@rslib/core';

export default defineConfig({
  lib: [
    { format: 'esm', syntax: 'es2022', dts: { bundle: true } },
    { format: 'cjs', syntax: 'es2022', dts: false },
  ],
  source: {
    entry: {
      index: 'src/index.ts',
      devices: 'src/devices.ts',
      e2ee: 'src/e2ee.ts',
      client: 'src/client.ts',
    },
  },
  output: { target: 'web', externals: [/^@mbsks\//, 'react'] },
});
