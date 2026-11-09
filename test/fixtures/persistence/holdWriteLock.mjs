// Test fixture (OD-12 contention test): another process holds the SQLite write lock.
// Usage: node holdWriteLock.mjs <database file> <hold milliseconds>
// Prints LOCKED once the write transaction is open, then commits after the hold time.
import { DatabaseSync } from 'node:sqlite';

const [file, holdText] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
db.prepare("INSERT INTO portfolios (id, base_currency, cash) VALUES ('pf-other-process', 'USD', '1')").run();
process.stdout.write('LOCKED\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number.parseInt(holdText ?? '0', 10));
db.exec('COMMIT');
db.close();
process.stdout.write('RELEASED\n');
