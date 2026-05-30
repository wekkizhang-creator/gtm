import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// `--mode pages` builds the static GitHub Pages site: browser-storage data layer,
// relative base (works under /<repo>/), output to the repo root so index.html sits
// at the top level. Normal `dev`/`build` keep the http (proxied) backend.
export default defineConfig(({ mode }) => {
  const pages = mode === 'pages';
  return {
    plugins: [react()],
    base: pages ? './' : '/',
    server: {
      port: 5173,
      proxy: {
        '/api': { target: 'http://localhost:4000', changeOrigin: true },
      },
    },
    build: pages ? { outDir: resolve(here, '..'), emptyOutDir: false } : {},
  };
});
