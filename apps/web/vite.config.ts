import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { navigateFallbackDenylist } from './src/lib/sw-navigation';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Hearth',
        short_name: 'Hearth',
        theme_color: '#2A7454',
        background_color: '#F6F1E7',
        display: 'standalone',
        // Drawn from public/favicon.svg. The maskable one keeps the flame inside the safe zone,
        // so Android's round and squircle masks never clip it.
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      // woff2 so the bundled fonts (D49) are there on an offline cold start, and the svg icon.
      workbox: { navigateFallbackDenylist, globPatterns: ['**/*.{js,css,html,woff2,svg}'] },
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
