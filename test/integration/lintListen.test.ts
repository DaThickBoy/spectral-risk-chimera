// Gateway rule 9 (static part): production code cannot call Fastify `.listen()` outside
// src/api/server.ts, so every listening server goes through `listenApiServer`, which refuses a
// server built without the Host and Origin request guard. Checked with the real ESLint config.
// Validates: Requirements 29.1
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, repoPath } from '../helpers/repo.js';

const MESSAGE = /Call \.listen\(\) only in src\/api\/server\.ts/;

async function listenFindings(code: string, file: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const [result] = await eslint.lintText(code, { filePath: repoPath(...file.split('/')) });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === 'no-restricted-syntax' && MESSAGE.test(message.message))
    .map((message) => `${String(message.line)}`);
}

const DIRECT = [
  'declare const app: { listen(o: object): Promise<string> };',
  'export const a = app.listen({ port: 0 });',
  'export const b = app?.listen({ port: 0 });',
  "export const c = app['listen']({ port: 0 });",
].join('\n');

describe('Gateway rule 9: no direct .listen() outside src/api/server.ts', () => {
  it.each([
    ['the composition root', 'src/main/example.ts'],
    ['an API module', 'src/api/example.ts'],
    ['an adapter', 'src/adapters/example.ts'],
    ['a financial module (its own lint block)', 'src/risk/example.ts'],
    ['the shared public API (its own lint block)', 'src/shared/index.ts'],
    ['the Decimal helper (its own lint block)', 'src/shared/decimal.ts'],
  ])('%s: dot, optional, and computed calls are each reported', async (_name, file) => {
    expect(await listenFindings(DIRECT, file)).toEqual(['2', '3', '4']);
  });

  it('the dashboard (its own lint block) is covered too', async () => {
    expect(await listenFindings(DIRECT, 'src/web/example.tsx')).toEqual(['2', '3', '4']);
  });

  it('src/api/server.ts, the guarded entry point, may call .listen()', async () => {
    expect(await listenFindings(DIRECT, 'src/api/server.ts')).toEqual([]);
  });

  it('reading a listen option, defining one, inject(), and listenApiServer() are not reported', async () => {
    const code = [
      'declare const app: { inject(o: object): Promise<unknown> };',
      'declare const options: { listen: { host: string; port: number } };',
      'declare function listenApiServer(a: unknown, o: unknown): Promise<string>;',
      'export const listen = { host: "127.0.0.1", port: 0 };',
      'export const opts = options.listen;',
      'export const injected = app.inject({ method: "GET", url: "/" });',
      'export const started = listenApiServer(app, options.listen);',
    ].join('\n');
    expect(await listenFindings(code, 'src/main/example.ts')).toEqual([]);
  });

  it('tests are not production code and may start their own servers', async () => {
    expect(await listenFindings(DIRECT, 'test/integration/example.test.ts')).toEqual([]);
  });
});
