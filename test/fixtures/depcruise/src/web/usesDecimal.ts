// Seeded violation: only the chart adapter may import the Decimal helper.
import { toChartNumber } from '../shared/decimal.js';
export const plotted = toChartNumber;
