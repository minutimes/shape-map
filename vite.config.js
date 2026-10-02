import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:4317',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    // Only this checkout's unit tests; never nested worktrees or browser checks.
    include: ['tests/**/*.test.{js,mjs,jsx}'],
    exclude: ['**/node_modules/**', '.claude/**', 'dist/**'],
  },
});
