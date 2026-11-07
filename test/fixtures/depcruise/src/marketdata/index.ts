// Seeded violation: a domain module imports a persistence implementation.
import { sqliteAdapter } from '../persistence/sqlite.js';

export const series = sqliteAdapter;
