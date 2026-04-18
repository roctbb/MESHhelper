import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'web'),
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: path.resolve(__dirname, 'web-dist'),
    emptyOutDir: true
  }
});
