// Deliberately failing sample used by test/integration/harness.test.ts (AT-CFG-03).
import { expect, it } from 'vitest';

it('fails on purpose', () => {
  expect(1).toBe(2);
});
