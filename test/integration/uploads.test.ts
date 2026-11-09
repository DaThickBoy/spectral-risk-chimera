// Task 4.4: safe upload handling (design: API gateway, uploads). Uses Fastify inject().
// Tests: AT-SEC-25, AT-CSV-08 (size part)
// Validates: Requirements 28.4, 29.6
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defineRoute, receiveUpload, sanitizeFilename, sendUploadRejection } from '../../src/api/index.js';
import type { ApiRoutes } from '../../src/api/index.js';
import { sequentialIds } from '../../src/shared/index.js';
import { z } from 'zod';
import { testServer } from '../helpers/api.js';
import { multipart } from '../helpers/multipart.js';
import type { MultipartPart } from '../helpers/multipart.js';

const LIMIT = 64;

function uploadServer(maxFileBytes = LIMIT) {
  const ids = sequentialIds('upload');
  const received: { storedName: string; originalName: string; size: number; text: string }[] = [];
  const routes: ApiRoutes = (app) =>
    defineRoute(app, {
      method: 'POST',
      url: '/portfolios/:id/uploads',
      params: z.strictObject({ id: z.string().regex(/^[a-z0-9-]+$/) }),
      upload: true,
      handler: async (_input, request, reply) => {
        const result = await receiveUpload(request, ids);
        if (!result.ok) {
          return sendUploadRejection(reply, request, result.reason);
        }
        const { storedName, originalName, size, bytes } = result.upload;
        received.push({ storedName, originalName, size, text: bytes.toString('utf8') });
        return { storedName, originalName, size: String(size) };
      },
    });
  const { app } = testServer([routes], undefined, {
    rateLimits: { perMinute: 1000, uploadPerMinute: 1000 },
    uploads: { maxFileBytes },
  });
  const send = (parts: readonly MultipartPart[], url = '/portfolios/pf-1/uploads') =>
    app.inject({ method: 'POST', url, ...multipart(parts) });
  return { app, send, received };
}

const file = (filename: string, content: string | Buffer = 'ticker,qty\nAAA,1\n'): MultipartPart => ({
  name: 'file',
  filename,
  content,
});

describe('AT-CSV-08 (size part): an oversized upload is rejected with FILE_TOO_LARGE before parsing', () => {
  it('a file of exactly import.maxFileBytes is accepted in memory, unchanged', async () => {
    const { send, received } = uploadServer();
    const content = 'a'.repeat(LIMIT);
    const response = await send([file('trades.csv', content)]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      storedName: 'upload-1',
      originalName: 'trades.csv',
      size: String(LIMIT),
    });
    expect(received).toEqual([
      { storedName: 'upload-1', originalName: 'trades.csv', size: LIMIT, text: content },
    ]);
  });

  it('one byte more is 413 FILE_TOO_LARGE; nothing reaches the handler', async () => {
    const { send, received } = uploadServer();
    const response = await send([file('trades.csv', 'a'.repeat(LIMIT + 1))]);
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: { code: 'FILE_TOO_LARGE', message: 'The uploaded file is too large.' },
    });
    expect(received).toEqual([]);
  });

  it('a file much larger than the 1 MiB JSON body limit is capped by maxFileBytes, not by it', async () => {
    const { send } = uploadServer(2 * 1024 * 1024);
    const big = Buffer.alloc(1536 * 1024, 0x61);
    expect((await send([file('big.csv', big)])).statusCode).toBe(200);
    expect((await send([file('big.csv', Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))])).statusCode).toBe(413);
  });
});

describe('AT-SEC-25: filenames are sanitized, never used as paths, and stored under generated names', () => {
  it.each([
    ['../../x.csv', 'x.csv'],
    ['..\\..\\windows\\win.ini', 'win.ini'],
    ['/etc/passwd', 'passwd'],
    ['C:\\Users\\a\\trades.csv', 'trades.csv'],
    ['.hidden.csv', 'hidden.csv'],
    ['..', 'upload'],
    ['', 'upload'],
    ['a\u0000b\u0007.csv', 'ab.csv'],
    // "</script>" contains "/", so only the last path segment "script>.csv" remains.
    ['<script>alert(1)</script>.csv', 'script_.csv'],
    ['<b>x|y?.csv', '_b_x_y_.csv'],
    ['trades 2026-11.csv', 'trades 2026-11.csv'],
    ['résumé.csv', 'r_sum_.csv'],
  ])('%j becomes %j', async (name, expected) => {
    expect(sanitizeFilename(name)).toBe(expected);
    const { send, received } = uploadServer();
    const response = await send([file(name)]);
    expect(response.statusCode).toBe(200);
    expect(received[0]?.originalName).toBe(expected);
    expect(received[0]?.storedName).toBe('upload-1');
  });

  it('long names are capped at 128 characters; non-strings fall back to "upload"', () => {
    expect(sanitizeFilename(`${'a'.repeat(300)}.csv`)).toHaveLength(128);
    expect(sanitizeFilename(undefined)).toBe('upload');
    expect(sanitizeFilename(42)).toBe('upload');
  });

  it('every upload gets a new generated name, even for the same client filename', async () => {
    const { send, received } = uploadServer();
    await send([file('same.csv')]);
    await send([file('same.csv')]);
    expect(received.map((entry) => entry.storedName)).toEqual(['upload-1', 'upload-2']);
  });

  it('the upload module performs no file system access', () => {
    const source = readFileSync('src/api/uploads.ts', 'utf8');
    expect(source).not.toMatch(/from ['"](node:)?fs(\/promises)?['"]/);
    expect(source).not.toMatch(/from ['"](node:)?path['"]/);
    expect(source).not.toMatch(/\b(writeFile|createWriteStream|mkdir|open)\s*\(/);
  });
});

describe('Upload shape', () => {
  it.each([
    ['two files', [file('a.csv'), file('b.csv')]],
    ['a form field', [{ name: 'mapping', content: '{}' }, file('a.csv')]],
    ['only a field', [{ name: 'mapping', content: '{}' }]],
    ['no parts', []],
  ])('%s is 400 UPLOAD_INVALID', async (_name, parts) => {
    const { send, received } = uploadServer();
    const response = await send(parts);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'UPLOAD_INVALID' } });
    expect(received).toEqual([]);
  });

  it('a non-multipart request to an upload route is 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const { app } = uploadServer();
    const response = await app.inject({
      method: 'POST',
      url: '/portfolios/pf-1/uploads',
      headers: { 'content-type': 'application/json' },
      payload: '{"file":"x"}',
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
  });

  it('path parameters and query of upload routes are still validated', async () => {
    const { send } = uploadServer();
    expect((await send([file('a.csv')], '/portfolios/PF!/uploads')).statusCode).toBe(400);
    expect((await send([file('a.csv')], '/portfolios/pf-1/uploads?x=1')).statusCode).toBe(400);
  });

  it('receiveUpload enforces exactly one file itself, independent of the parser limits', async () => {
    const filePart = (filename: string) => ({
      type: 'file' as const,
      filename,
      mimetype: 'text/csv',
      file: { resume: () => undefined },
      toBuffer: async () => Buffer.from('x'),
    });
    const fake = (parts: readonly unknown[]) =>
      ({
        isMultipart: () => true,
        parts: async function* () {
          yield* parts;
        },
      }) as unknown as Parameters<typeof receiveUpload>[0];
    const ids = sequentialIds('direct');
    expect(await receiveUpload(fake([filePart('a.csv'), filePart('b.csv')]), ids)).toEqual({
      ok: false,
      reason: 'UPLOAD_INVALID',
    });
    expect(
      await receiveUpload(fake([{ type: 'field', fieldname: 'x', value: 'y' }, filePart('a.csv')]), ids),
    ).toEqual({
      ok: false,
      reason: 'UPLOAD_INVALID',
    });
    expect(await receiveUpload(fake([]), ids)).toEqual({ ok: false, reason: 'UPLOAD_INVALID' });
    expect(await receiveUpload(fake([filePart('../a.csv')]), ids)).toMatchObject({
      ok: true,
      upload: { originalName: 'a.csv', storedName: 'direct-3' },
    });
  });

  it('an upload route cannot also declare a JSON body schema', () => {
    const routes: ApiRoutes = (app) =>
      defineRoute(app, {
        method: 'POST',
        url: '/bad',
        upload: true,
        body: z.strictObject({}),
        handler: async () => ({}),
      });
    expect(() => testServer([routes])).toThrow(TypeError);
  });
});
