// Task 10.1, FX rule 8: an unexpected `dataStatus` for a fresh, validated rate is returned as
// FX_UNAVAILABLE (INVALID_RESPONSE); rateToBase never throws for it (Result contract).
// The shared `dataStatus` is replaced only in this file, because the case cannot occur
// through valid inputs after rules 5 to 7.
// Validates: Requirements 30.8, 25.4
import { describe, expect, it, vi } from 'vitest';
import type * as Shared from '../../../src/shared/index.js';
import { fakeProvider, fxSetup, okResult, quote } from '../../helpers/fx.js';

const statusFor = vi.hoisted(() => ({ value: 'UNAVAILABLE' }));

vi.mock('../../../src/shared/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof Shared>();
  return { ...original, dataStatus: () => statusFor.value };
});

describe('FX rule 8: defensive status handling', () => {
  it.each(['UNAVAILABLE', 'STALE', 'CACHED'])(
    'a fresh rate with status %s resolves to FX_UNAVAILABLE (INVALID_RESPONSE), never a rejection',
    async (status) => {
      statusFor.value = status;
      const { rate } = fxSetup(fakeProvider(() => okResult(quote())));
      await expect(rate('EUR')).resolves.toEqual({
        ok: false,
        error: {
          code: 'FX_UNAVAILABLE',
          message: 'FX rate EURUSD is unavailable (INVALID_RESPONSE).',
          currency: 'EUR',
          cause: 'INVALID_RESPONSE',
        },
      });
    },
  );

  it('the expected statuses still pass through', async () => {
    statusFor.value = 'CURRENT';
    const { rate } = fxSetup(fakeProvider(() => okResult(quote())));
    await expect(rate('EUR')).resolves.toMatchObject({ ok: true, value: { status: 'CURRENT' } });
  });
});
