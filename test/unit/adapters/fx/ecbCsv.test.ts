// AT-FX-15: any deviation from the fixed ECB CSV format rejects the whole response.
// Recorded responses (test/fixtures/fx/ecb/, Source: ECB statistics.) parse exactly.
// Validates: Requirements 30.3, 4.6
import { describe, expect, it } from 'vitest';
import { ECB_CSV_HEADER, parseEcbCsv } from '../../../../src/adapters/index.js';
import { recorded } from '../../../helpers/ecb.js';

const OPTIONS = {
  contentType: 'text/csv',
  requested: ['GBP', 'USD'],
  asOf: '2026-11-06',
  maxBytes: 1_048_576,
};
const ROW_GBP = 'EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-11-06,0.83415';
const ROW_USD = 'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-11-06,1.1165';
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const body = (...rows: string[]): string => [ECB_CSV_HEADER, ...rows].join('\r\n') + '\r\n';

describe('parseEcbCsv: recorded responses', () => {
  it('parses the recorded Friday response exactly, keeping the published text', () => {
    expect(parseEcbCsv(recorded('exr-gbp-usd-2026-11-06.csv'), OPTIONS)).toEqual({
      ok: true,
      value: [
        { currency: 'GBP', date: '2026-11-05', value: '0.83393' },
        { currency: 'GBP', date: '2026-11-06', value: '0.83415' },
        { currency: 'USD', date: '2026-11-05', value: '1.1224' },
        { currency: 'USD', date: '2026-11-06', value: '1.1165' },
      ],
    });
  });

  it.each([
    ['exr-gbp-usd-2026-11-07.csv', '2026-11-07', ['2026-11-05', '2026-11-06']],
    ['exr-gbp-usd-2026-10-26.csv', '2026-10-26', ['2026-10-23', '2026-10-26']],
    ['exr-gbp-usd-2026-04-07.csv', '2026-04-07', ['2026-04-02', '2026-04-07']],
    ['exr-gbp-usd-2025-12-29.csv', '2025-12-29', ['2025-12-24', '2025-12-29']],
  ])('%s: two rows per currency, the TARGET gap kept as a gap', (file, asOf, dates) => {
    const parsed = parseEcbCsv(recorded(file), { ...OPTIONS, asOf });
    expect(parsed.ok && parsed.value.filter((r) => r.currency === 'USD').map((r) => r.date)).toEqual(dates);
    expect(parsed.ok && parsed.value.filter((r) => r.currency === 'GBP').map((r) => r.date)).toEqual(dates);
  });

  it('accepts LF endings, no trailing newline, and charset=utf-8', () => {
    expect(parseEcbCsv(enc([ECB_CSV_HEADER, ROW_GBP].join('\n')), OPTIONS).ok).toBe(true);
    expect(parseEcbCsv(enc(body(ROW_GBP)), { ...OPTIONS, contentType: 'text/csv; charset=utf-8' }).ok).toBe(
      true,
    );
    expect(parseEcbCsv(enc(body(ROW_GBP)), { ...OPTIONS, contentType: 'TEXT/CSV;charset=UTF-8' }).ok).toBe(
      true,
    );
  });

  it('a header-only response is valid and has no rows (missing observations are not invented)', () => {
    expect(parseEcbCsv(enc(body()), OPTIONS)).toEqual({ ok: true, value: [] });
  });
});

describe('parseEcbCsv: every deviation is INVALID_RESPONSE', () => {
  const rejects = (bytes: Uint8Array, options: Partial<typeof OPTIONS> = {}): void => {
    expect(parseEcbCsv(bytes, { ...OPTIONS, ...options })).toEqual({ ok: false, error: 'INVALID_RESPONSE' });
  };

  it.each([
    ['no Content-Type', undefined],
    ['application/json', 'application/json'],
    ['text/plain', 'text/plain'],
    ['other charset', 'text/csv; charset=iso-8859-1'],
    ['csv with extra parameter', 'text/csv; header=present'],
  ])('Content-Type: %s', (_name, contentType) => {
    rejects(enc(body(ROW_GBP)), { contentType: contentType as string });
  });

  it('a body over maxBytes', () => {
    const bytes = enc(body(ROW_GBP));
    rejects(bytes, { maxBytes: bytes.length - 1 });
    expect(parseEcbCsv(bytes, { ...OPTIONS, maxBytes: bytes.length }).ok).toBe(true);
  });

  it('a byte-order mark', () => {
    rejects(new Uint8Array([0xef, 0xbb, 0xbf, ...enc(body(ROW_GBP))]));
  });

  it('invalid UTF-8', () => {
    rejects(new Uint8Array([...enc(body(ROW_GBP)).slice(0, -2), 0xff, 0x0a]));
  });

  it.each([
    ['empty body', ''],
    [
      'header only, wrong order',
      'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,OBS_VALUE,TIME_PERIOD\r\n',
    ],
    ['lower-case header', `${ECB_CSV_HEADER.toLowerCase()}\r\n${ROW_GBP}\r\n`],
    ['extra header column', `${ECB_CSV_HEADER},OBS_STATUS\r\n${ROW_GBP},A\r\n`],
    ['quoted field', body('"EXR.D.GBP.EUR.SP00.A",D,GBP,EUR,SP00,A,2026-11-06,0.83415')],
    ['seven fields', body('EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-11-06')],
    ['nine fields', body(`${ROW_GBP},X`)],
    ['empty line between rows', body(ROW_GBP, '', ROW_USD)],
    ['two trailing newlines', `${body(ROW_GBP)}\r\n`],
    ['key mismatch', body('EXR.D.USD.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-11-06,0.83415')],
    ['monthly frequency', body('EXR.D.GBP.EUR.SP00.A,M,GBP,EUR,SP00,A,2026-11-06,0.83415')],
    ['other denominator', body('EXR.D.GBP.EUR.SP00.A,D,GBP,USD,SP00,A,2026-11-06,0.83415')],
    ['other type', body('EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP01,A,2026-11-06,0.83415')],
    ['other suffix', body('EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,E,2026-11-06,0.83415')],
    ['unrequested currency', body('EXR.D.JPY.EUR.SP00.A,D,JPY,EUR,SP00,A,2026-11-06,170.1')],
    ['invalid date', body('EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-02-30,0.83415')],
    ['monthly period', body('EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-11,0.83415')],
    ['date after asOf', body('EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-11-07,0.83415')],
    ['empty OBS_VALUE', body('EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-11-06,')],
    ['exponent', body('EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-11-06,8.3415e-1')],
    ['NaN', body('EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-11-06,NaN')],
    ['zero', body('EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-11-06,0')],
    ['negative', body('EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-11-06,-0.83415')],
    ['leading plus', body('EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-11-06,+0.83415')],
    ['space in value', body('EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-11-06, 0.83415')],
    ['repeated currency and date', body(ROW_GBP, ROW_GBP)],
    [
      'valid rows then one bad row',
      body(ROW_GBP, ROW_USD, 'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-11-05,x'),
    ],
  ])('%s', (_name, text) => {
    rejects(enc(text));
  });
});
