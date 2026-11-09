// Dashboard build (task 17.2; DR-KW-1 H4): a separate Vite build of src/web/ into dist/web/.
// `base: './'` keeps every asset path relative, so the same build works from GitHub Pages
// (static replay) and from a local preview. No secret or backend address is compiled in:
// the data source is chosen with VITE_DASHBOARD_SOURCE ("replay", the default, or "live").
// In development, `/dashboard` is proxied to the local demo backend named by
// SRC_DASHBOARD_BACKEND (for example http://127.0.0.1:8080); the backend stays on loopback.
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
    ...(backend === undefined ? {} : { proxy: { '/dashboard': { target: backend, changeOrigin: false } } }),
  },
  preview: { host: '127.0.0.1' },
});
