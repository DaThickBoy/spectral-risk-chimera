// Test fixture (OD-12 recovery test): commits one portfolio, then is killed inside a second
// transaction that already wrote a portfolio and a transaction row.
// Usage: node crashMidTransaction.mjs <database file>
import { DatabaseSync } from 'node:sqlite';

const [file] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA synchronous = FULL');
db.exec('BEGIN IMMEDIATE');
db.prepare("INSERT INTO portfolios (id, base_currency, cash) VALUES ('pf-committed', 'USD', '100')").run();
db.exec('COMMIT');
db.exec('BEGIN IMMEDIATE');
db.prepare("INSERT INTO portfolios (id, base_currency, cash) VALUES ('pf-partial', 'USD', '5')").run();
process.stdout.write('IN_TRANSACTION\n');
// No COMMIT: the process ends abruptly with the transaction open.
process.kill(process.pid, 'SIGKILL');
