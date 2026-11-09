/**
 * Location of the compiled risk worker (task 12.4; architecture rule 1). Resolved
 * next to this module, so in `dist/risk/` it is `dist/risk/riskWorker.js`.
 */
export const RISK_WORKER_URL: URL = new URL('./riskWorker.js', import.meta.url);
