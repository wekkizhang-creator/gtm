import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA talks to the backend only through /api. In dev we proxy /api to the
// Express server so the frontend stays host-agnostic (same code works when the
// API is embedded in an Electron build later).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
