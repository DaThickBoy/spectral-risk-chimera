// Task 10.3, recording rule 1 (D5): INVALID_RESPONSE from the FX rule 8 status guard is never
// recorded and never updates the last valid rate, although its rate passed rules 5 and 6.
// The shared `dataStatus` is replaced only in this file, because the case cannot occur through
// valid inputs.
// Validates: Requirements 22.3, 30.5, 30.12
import { describe, expect, it, vi } from 'vitest';
import type * as Shared from '../../../src/shared/index.js';
import { fakeProvider, okResult, quote } from '../../helpers/fx.js';
import { recorderSetup } from '../../helpers/fxRecorder.js';

vi.mock('../../../src/shared/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof Shared>();
  return { ...original, dataStatus: () => 'UNAVAILABLE' };
});

describe('D5: the status-guard INVALID_RESPONSE is not recorded', () => {
  it('writes nothing, touches no unit of work, and leaves the last valid store empty', async () => {
    const { rate, uow, lastValid } = recorderSetup(fakeProvider(() => okResult(quote())));
    await expect(rate('EUR')).resolves.toMatchObject({
      ok: false,
      error: { code: 'FX_UNAVAILABLE', cause: 'INVALID_RESPONSE' },
    });
    expect(uow.snapshot().fxRates).toEqual([]);
    expect(uow.lastAttempt).toBeUndefined();
    expect(lastValid.size).toBe(0);
  });
});
