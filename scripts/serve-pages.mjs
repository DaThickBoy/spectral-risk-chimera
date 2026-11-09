// Local static server with GitHub Pages path semantics, for previews and the Playwright E2E tests
// (task 17.5; OD-21). Serves dist/web/ under the repository subpath, read-only:
//
//   node scripts/serve-pages.mjs [--root dist/web] [--base /spectral-risk-chimera/] [--port 4173]
//
// - `/<base>` (no trailing slash) redirects to `/<base>/`, as GitHub Pages does for a directory.
// - `/<base>/` serves index.html; other paths under the base serve files from the root.
// - Anything outside the base, a missing file, or a path escaping the root is 404.
// - Only GET and HEAD are served (405 otherwise): there is no backend and no write route.
// Bound to 127.0.0.1 only. No dependency beyond Node.js.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};
const root = path.resolve(arg('--root', 'dist/web'));
const base = arg('--base', '/spectral-risk-chimera/');
const port = Number.parseInt(arg('--port', '4173'), 10);
if (!base.startsWith('/') || !base.endsWith('/')) {
  throw new Error('--base must start and end with "/".');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === base.slice(0, -1)) {
    response.writeHead(301, { Location: `${base}${url.search}` }).end();
    return;
  }
  if (!url.pathname.startsWith(base)) {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  const relative = decodeURIComponent(url.pathname.slice(base.length)) || 'index.html';
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Serving ${root} at http://127.0.0.1:${String(port)}${base}\n`);
});
