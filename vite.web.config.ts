// Dashboard build (task 17.2; DR-KW-1 H4): a separate Vite build of src/web/ into dist/web/.
// `base: './'` keeps every asset path relative, so the same build works from GitHub Pages
// (static replay) and from a local preview. No secret or backend address is compiled in:
// the data source is chosen with VITE_DASHBOARD_SOURCE ("replay", the default, or "live").
// In development, `/dashboard` is proxied to the local demo backend named by
// SRC_DASHBOARD_BACKEND (for example http://127.0.0.1:8080); the backend stays on loopback.
// `changeOrigin: true` makes the proxy send the backend's own `Host` (127.0.0.1:<backend port>),
// which the backend's Host guard (Gateway rule 9) requires; the proxied requests are GET only.
import { defineConfig } from 'vite';

const backend = process.env['SRC_DASHBOARD_BACKEND'];

export default defineConfig({
  root: 'src/web',
  base: './',
  publicDir: 'public',
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    // `/stream` (task 17.4): the read-only WebSocket. The browser's Origin is forwarded unchanged,
    // so start the backend with `--allowed-origin` set to this dev server's origin.
    ...(backend === undefined
      ? {}
      : {
          proxy: {
            '/dashboard': { target: backend, changeOrigin: true },
            '/stream': { target: backend, changeOrigin: true, ws: true },
          },
        }),
  },
  preview: { host: '127.0.0.1' },
});
