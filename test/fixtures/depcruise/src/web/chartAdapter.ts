// Allowed: the chart adapter may import the Decimal helper for toChartNumber (R4.4).
import { toChartNumber } from '../shared/decimal.js';
// Seeded violation: even the chart adapter must not import a domain module.
import { riskInput } from '../risk/index.js';
export const plotted = [toChartNumber, riskInput];
