// Seeded violation: importing another module's internal file instead of its index.ts.
import { internalDetail } from '../risk/internal.js';

export const alert = internalDetail;
