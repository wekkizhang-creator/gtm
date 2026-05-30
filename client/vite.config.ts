import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `--mode pages` builds the static GitHub Pages site: browser-storage data layer
// (VITE_API=local via .env.pages) and a relative base so it works under /<repo>/.
// Output goes to client/dist, which the Pages workflow uploads. Normal dev/build
// keep the http (proxied) backend.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'pages' ? './' : '/',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
}));
