import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5173,
    // The game is usually opened through a tunnel / VPS hostname (e.g.
    // https://3001-<id>.instabox.tech). Vite rejects unknown Host headers
    // with a 403 unless allowed, so permit any host.
    allowedHosts: true,
  },
  preview: {
    host: true,
    // production build, exposed on the VPS's open port
    port: 3001,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
  },
});
