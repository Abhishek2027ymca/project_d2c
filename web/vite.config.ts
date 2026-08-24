import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Built into the API's own tree so one Express process serves both in
  // production. Keeps this a single deployable service -- no second host to
  // keep awake, and no CORS, because the dashboard and the API share an origin.
  build: { outDir: '../public', emptyOutDir: true },
  server: {
    port: 5173,
    // In dev the two run separately (Vite for hot reload, tsx for the API), so
    // API calls are proxied to keep the frontend's fetches same-origin here too.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
});
