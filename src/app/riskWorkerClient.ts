/**
 * Risk worker client (task 12.4; design: Risk Worker and Scheduler; R23.4, R26.8,
 * R22.6, R33.9).
 *
 * - The worker is created once, on first use, from the compiled JavaScript entry
 *   point (`RISK_WORKER_URL`, or an injected URL in tests). Requests carry the
 *   canonical JSON of the `RiskInput`; responses carry the canonical JSON of the
 *   `RiskResult`, validated with Zod before use. No native number crosses the
 *   boundary for a financial value.
 * - A worker crash (an `error` event or an unexpected exit) rejects every pending
 *   request with `RiskWorkerError`, is audited as `CALCULATION`/
 *   `CALCULATION_ERROR` (no input text, R22.6), and the next request starts a new
 *   worker (restart). A calculation that fails inside the worker rejects only that
 *   request. Nothing is retried automatically and no figure is fabricated.
 * - `close()` terminates the worker.
 */
import { Worker } from 'node:worker_threads';
import { recordAuditEvent } from '../audit/index.js';
import type { UnitOfWork } from '../persistence/ports.js';
import { PersistenceError } from '../persistence/ports.js';
import { RISK_WORKER_URL } from '../risk/index.js';
import type { RiskInput, RiskResult } from '../risk/index.js';
import { canonicalJson } from '../shared/index.js';
import type { Clock, IdGenerator } from '../shared/index.js';
import { RiskResultSchema } from './riskService.js';

export class RiskWorkerError extends Error {
  constructor(readonly code: 'WORKER_CRASHED' | 'CALCULATION_ERROR' | 'INVALID_RESULT' | 'CLOSED') {
    super(`Risk worker failure (${code}).`);
    this.name = 'RiskWorkerError';
  }
}

export interface RiskWorkerClient {
  compute(input: RiskInput): Promise<RiskResult>;
  close(): Promise<void>;
  /** Number of workers started so far (1 plus restarts); for monitoring and tests. */
  readonly starts: number;
}

export interface RiskWorkerClientDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Defaults to the compiled `RISK_WORKER_URL`; tests inject a JavaScript fixture. */
  readonly workerUrl?: URL;
}

interface Pending {
  readonly resolve: (result: RiskResult) => void;
  readonly reject: (error: Error) => void;
}

export function createRiskWorkerClient(deps: RiskWorkerClientDependencies): RiskWorkerClient {
  const url = deps.workerUrl ?? RISK_WORKER_URL;
  let worker: Worker | undefined;
  let starts = 0;
  let closed = false;
  const pending = new Map<string, Pending>();

  const audit = (reason: string): void => {
    try {
      recordAuditEvent(deps.unitOfWork, {
        id: deps.ids.next(),
        at: deps.clock.nowUtc().toISOString(),
        category: 'CALCULATION',
        type: 'CALCULATION_ERROR',
        details: { component: 'riskWorker', reason, pending: String(pending.size) },
      });
    } catch (error) {
      if (!(error instanceof PersistenceError)) {
        throw error;
      }
    }
  };

  const crash = (current: Worker, reason: string): void => {
    if (worker !== current) {
      return;
    }
    worker = undefined;
    audit(reason);
    const failed = [...pending.values()];
    pending.clear();
    for (const request of failed) {
      request.reject(new RiskWorkerError('WORKER_CRASHED'));
    }
  };

  const start = (): Worker => {
    const created = new Worker(url);
    starts += 1;
    created.on('message', (message: unknown) => {
      const reply = (typeof message === 'object' && message !== null ? message : {}) as {
        id?: unknown;
        ok?: unknown;
        result?: unknown;
      };
      const request = typeof reply.id === 'string' ? pending.get(reply.id) : undefined;
      if (request === undefined || typeof reply.id !== 'string') {
        return;
      }
      pending.delete(reply.id);
      if (reply.ok !== true || typeof reply.result !== 'string') {
        request.reject(new RiskWorkerError('CALCULATION_ERROR'));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(reply.result); // canonical JSON from the worker; validated below
      } catch {
        request.reject(new RiskWorkerError('INVALID_RESULT'));
        return;
      }
      const result = RiskResultSchema.safeParse(parsed);
      if (result.success) {
        request.resolve(result.data as RiskResult);
      } else {
        request.reject(new RiskWorkerError('INVALID_RESULT'));
      }
    });
    created.on('error', () => crash(created, 'WORKER_ERROR'));
    created.on('exit', (code) => crash(created, `WORKER_EXIT_${String(code)}`));
    return created;
  };

  return {
    compute: (input) => {
      if (closed) {
        return Promise.reject(new RiskWorkerError('CLOSED'));
      }
      worker ??= start();
      const id = deps.ids.next();
      const target = worker;
      return new Promise<RiskResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        target.postMessage({ id, input: canonicalJson(input) });
      });
    },
    close: async () => {
      closed = true;
      const current = worker;
      worker = undefined;
      for (const request of pending.values()) {
        request.reject(new RiskWorkerError('CLOSED'));
      }
      pending.clear();
      if (current !== undefined) {
        await current.terminate();
      }
    },
    get starts() {
      return starts;
    },
  };
}
