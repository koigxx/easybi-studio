import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 8931,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8932',
        changeOrigin: true,
      },
    },
  },
  // Same /api proxy for `vite preview`, so serving the built app locally also
  // reaches the Studio Service instead of returning index.html for /api/*.
  preview: {
    host: '127.0.0.1',
    port: 8931,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8932',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
