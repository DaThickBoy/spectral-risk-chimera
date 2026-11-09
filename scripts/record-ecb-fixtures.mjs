// Records the ECB FX fixtures of task 10.2 (design: ECB adapter rule 9, U11).
//
// Manual command only; never run by tests or CI (tests never use the network):
//
//   node scripts/record-ecb-fixtures.mjs
//
// It requests each fixed query below from the ECB data API exactly as the adapter does
// (ECB adapter rule 1: fixed endpoint, `endPeriod`, `lastNObservations=2`, `detail=dataonly`,
// `format=csvdata`, `Accept: text/csv`, no credentials, TLS verification on) and writes the
// response body byte for byte to test/fixtures/fx/ecb/<name>.csv. It prints the HTTP status,
// the Content-Type, the byte length, and the SHA-256 of every body, so a refresh is a
// reviewed diff of both the files and test/fixtures/fx/ecb/README.md. Nothing is edited or
// normalized. Source: ECB statistics.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { request } from 'node:https';
import process from 'node:process';
import { URL } from 'node:url';

const ENDPOINT = 'https://data-api.ecb.europa.eu/service/data/EXR/';

/** Fixed queries: name, sorted currencies, and endPeriod. */
const QUERIES = [
  { name: 'exr-gbp-usd-2026-11-06', currencies: ['GBP', 'USD'], endPeriod: '2026-11-06' },
  { name: 'exr-gbp-usd-2026-11-07', currencies: ['GBP', 'USD'], endPeriod: '2026-11-07' },
  { name: 'exr-gbp-usd-2026-10-26', currencies: ['GBP', 'USD'], endPeriod: '2026-10-26' },
  { name: 'exr-gbp-usd-2026-04-07', currencies: ['GBP', 'USD'], endPeriod: '2026-04-07' },
  { name: 'exr-gbp-usd-2025-12-29', currencies: ['GBP', 'USD'], endPeriod: '2025-12-29' },
];

function queryUrl(currencies, endPeriod) {
  const key = `D.${[...currencies].sort().join('+')}.EUR.SP00.A`;
  const params = `endPeriod=${endPeriod}&lastNObservations=2&detail=dataonly&format=csvdata`;
  return `${ENDPOINT}${key}?${params}`;
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(url), {
      method: 'GET',
      headers: { Accept: 'text/csv' },
      rejectUnauthorized: true,
    });
    req.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          contentType: response.headers['content-type'],
          body: Buffer.concat(chunks),
        }),
      );
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  for (const query of QUERIES) {
    const url = queryUrl(query.currencies, query.endPeriod);
    const response = await get(url);
    if (response.status !== 200) {
      process.stderr.write(`${query.name}: HTTP ${response.status}; nothing written\n`);
      process.exitCode = 1;
      continue;
    }
    const file = new URL(`../test/fixtures/fx/ecb/${query.name}.csv`, import.meta.url);
    writeFileSync(file, response.body);
    const sha = createHash('sha256').update(response.body).digest('hex');
    process.stdout.write(
      `${query.name}.csv  ${url}\n  status ${response.status}, content-type ${response.contentType}, ` +
        `${response.body.length} bytes, sha256 ${sha}\n`,
    );
  }
}

await main();
