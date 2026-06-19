import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Hearth',
        short_name: 'Hearth',
        theme_color: '#2E9E5B',
        display: 'standalone',
      },
    }),
  ],
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'] },
  server: {
    port: 5173,
    // Proxy API + auth to the server so the browser sees ONE origin. Cross-origin
    // (:5173 -> :3000) breaks Better Auth's SameSite=Lax session cookie in the browser
    // even though in-process app.inject tests pass. Keep client URLs relative (Task 10).
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/trpc': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
