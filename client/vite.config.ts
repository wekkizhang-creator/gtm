import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: process.env.VITE_APP_BASE || (mode === 'pages' ? './' : mode === 'production' ? '/efficiency-list/' : '/'),
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
}));
