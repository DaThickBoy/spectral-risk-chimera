// Seeded violations: constructing and configuring Decimal.js outside src/shared/decimal.ts.
import { Decimal } from 'decimal.js';

export const value = new Decimal('1.5');
export const Clone = Decimal.clone({ precision: 10 });
