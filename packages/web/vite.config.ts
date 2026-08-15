import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    // Cloudflare Quick Tunnels use a fresh random subdomain on every run.
    // The leading dot permits only that domain family, not arbitrary hosts.
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      // Keeps the browser same-origin in development, so no CORS or token juggling.
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:4000', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // The function form, not the object form. Vite 8 bundles with rolldown
        // rather than rollup, and rolldown only calls `manualChunks` — handing
        // it an object fails the build with "manualChunks is not a function".
        // Rollup accepts both, so this stays correct if the bundler changes
        // back.
        //
        // Matching is on the package name parsed out of the path, never a
        // substring: `react` must not also catch `react-grid-layout` or
        // `lucide-react`, which is exactly what a naive `id.includes('react')`
        // would do.
        manualChunks(id: string): string | undefined {
          const path = id.replace(/\\/g, '/');
          const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path)?.[1];
          if (!pkg) return undefined;
          if (['react', 'react-dom', 'react-router', 'react-router-dom', 'scheduler'].includes(pkg)) return 'react';
          if (pkg === 'recharts') return 'charts';
          if (pkg === '@tanstack/react-query') return 'query';
          return undefined;
        },
      },
    },
  },
});
