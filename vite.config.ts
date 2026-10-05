/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// The edition is fixed at build time by the Vite mode: `--mode steam` builds the Steam edition into
// dist-steam/; every other mode (development, production, test) is the itch.io edition in dist/.
// src/edition.ts is the only code that reads the injected value.
export default defineConfig(({ mode }) => {
  const steam = mode === 'steam';
  return {
    base: './',
    define: {
      __EDITION__: JSON.stringify(steam ? 'steam' : 'itch'),
    },
    build: {
      target: 'es2022',
      outDir: steam ? 'dist-steam' : 'dist',
      assetsInlineLimit: 0,
    },
    server: {
      port: 5173,
    },
    test: {
      include: ['tests/**/*.test.ts'],
      environment: 'node',
    },
  };
});
