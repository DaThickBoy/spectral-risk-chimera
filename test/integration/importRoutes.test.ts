// Task 7.5: import routes through Fastify inject() (design: API routes, Gateway rules, uploads).
// The real parser, import service, use case, and in-memory unit of work; settings are TEST values.
// Tests: AT-CSV-05, AT-CSV-16, AT-AUD-01, AT-POS-04
// Validates: Requirements 1.2, 1.4, 3.3, 28.9, 28.10, 28.17, 29.4, 29.6
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { importRoutes } from '../../src/api/index.js';
import {
  ApiErrorBodySchema,
  ImportCreatedSchema,
  ImportRejectionsResponseSchema,
  ImportSummarySchema,
  sequentialIds,
} from '../../src/shared/index.js';
import { jsonNumbers, testServer } from '../helpers/api.js';
import { csv } from '../helpers/importRows.js';
import { NOW, PF, useCaseHarness } from '../helpers/importService.js';
import { multipart } from '../helpers/multipart.js';

function setup() {
  const h = useCaseHarness();
  const { app } = testServer([importRoutes({ imports: h.useCase, ids: sequentialIds('upload') })]);
  const upload = (text: string, query = '', portfolio = PF) => {
    const { headers, payload } = multipart([{ name: 'file', filename: '../evil/trades.csv', content: text }]);
    return app.inject({ method: 'POST', url: `/portfolios/${portfolio}/imports${query}`, headers, payload });
  };
  return { ...h, app, upload };
}

const FILE = csv(
  '2026-11-02T14:30:00Z,AAA,BUY,10,150.2500,USD',
  '2026-11-02T14:31:00Z,AAA,HOLD,1,1,USD',
  '2026-11-02T14:32:00Z,BBB,BUY,2,45.5,EUR',
);

describe('POST /portfolios/:id/imports', () => {
  it('201 with the summary; valid rows committed, invalid rows quarantined (AT-CSV-05, AT-CSV-16)', async () => {
    const s = setup();
    const response = await s.upload(FILE);
    expect(response.statusCode).toBe(201);
    const body = ImportCreatedSchema.parse(response.json());
    expect(body).toMatchObject({
      fileName: 'trades.csv',
      fileSha256: createHash('sha256').update(FILE).digest('hex'),
      importedAt: NOW,
      totalRows: 3,
      accepted: 2,
      rejected: 1,
      duplicates: 0,
      skipped: 0,
      status: 'COMMITTED_WITH_REJECTIONS',
      positions: 'REBUILT',
    });
    expect(response.json()).not.toHaveProperty('persisted');
    expect(
      s.inner
        .snapshot()
        .positions.map((p) => p.ticker)
        .sort(),
    ).toEqual(['AAA', 'BBB']);
  });

  it('applies the column mapping and the source label from the query (AT-AUD-01)', async () => {
    const s = setup();
    const text = 'Date,Sym,Side,Qty,Px,Ccy\n2026-11-02T14:30:00Z,AAA,BUY,10,1,USD\n';
    const response = await s.upload(
      text,
      '?source=BROKER-X&trade_timestamp=Date&ticker=Sym&type=Side&quantity=Qty&price=Px&currency=Ccy',
    );
    expect(response.statusCode).toBe(201);
    const [tx] = s.inner.snapshot().transactions;
    expect(tx).toMatchObject({ source: 'BROKER-X', sourceId: `CSV:${String(response.json().fileSha256)}` });
  });

  it('a file-level rejection is stored and returned as FAILED', async () => {
    const s = setup();
    const response = await s.upload('');
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: 'FAILED', failureReason: 'INVALID_HEADER' });
  });

  it('404 for an unknown portfolio; 400 for an invalid mapping or unknown query field', async () => {
    const s = setup();
    expect((await s.upload(FILE, '', 'pf-unknown')).statusCode).toBe(404);
    const dup = await s.upload(FILE, '?ticker=x&currency=x');
    expect(dup.statusCode).toBe(400);
    expect(ApiErrorBodySchema.parse(dup.json()).error.code).toBe('VALIDATION_FAILED');
    expect((await s.upload(FILE, '?unknown=1')).statusCode).toBe(400);
    expect((await s.upload(FILE, '?source=bad%20label')).statusCode).toBe(400);
    expect(s.inner.snapshot().imports).toEqual([]);
  });

  it('a commit failure is a generic 500; nothing is stored and positions are unchanged (AT-POS-04)', async () => {
    const s = setup();
    s.uow.armRun(2, 0); // 0 portfolio lookup, 1 ledger read, 2 import commit
    const response = await s.upload(FILE);
    expect(response.statusCode).toBe(500);
    expect(ApiErrorBodySchema.parse(response.json()).error.code).toBe('INTERNAL_ERROR');
    const snap = s.inner.snapshot();
    expect([snap.transactions, snap.imports, snap.quarantine, snap.positions]).toEqual([[], [], [], []]);
  });

  it('a non-multipart request is 415', async () => {
    const s = setup();
    const response = await s.app.inject({
      method: 'POST',
      url: `/portfolios/${PF}/imports`,
      headers: { 'content-type': 'text/csv' },
      payload: FILE,
    });
    expect(response.statusCode).toBe(415);
  });
});

describe('GET /imports/:id and /imports/:id/rejections', () => {
  it('returns the stored summary and its rejections; counts are integers, no financial JSON numbers', async () => {
    const s = setup();
    const created = ImportCreatedSchema.parse((await s.upload(FILE)).json());
    const summary = await s.app.inject({ method: 'GET', url: `/imports/${created.importId}` });
    expect(summary.statusCode).toBe(200);
    expect(created.positions).toBe('REBUILT');
    expect(ImportSummarySchema.parse(summary.json())).toEqual(
      Object.fromEntries(Object.entries(created).filter(([key]) => key !== 'positions')),
    );
    const rejections = await s.app.inject({ method: 'GET', url: `/imports/${created.importId}/rejections` });
    expect(rejections.statusCode).toBe(200);
    const body = ImportRejectionsResponseSchema.parse(rejections.json());
    expect(body.rejections.map((r) => [r.sequence, r.reasonCode, r.column])).toEqual([
      [2, 'UNSUPPORTED_TRANSACTION_TYPE', 'type'],
    ]);
    // Only integer counts and row numbers are JSON numbers.
    expect(jsonNumbers(rejections.json())).toEqual(['$.rejections[0].sequence']);
  });

  it('404 for an unknown import; 400 for an invalid id', async () => {
    const s = setup();
    expect((await s.app.inject({ method: 'GET', url: '/imports/nope' })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'GET', url: '/imports/nope/rejections' })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'GET', url: '/imports/a%20b' })).statusCode).toBe(400);
  });
});
