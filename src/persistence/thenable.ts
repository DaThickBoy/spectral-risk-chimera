/**
 * Guard against asynchronous unit-of-work callbacks (task 5.1), shared by every
 * persistence adapter (OD-12): `UnitOfWork.run` is synchronous, so a returned
 * thenable is refused, and it gets a rejection handler first so it can never
 * become an unhandled rejection.
 */
import { types } from 'node:util';

const ignoreRejection = (): undefined => undefined;

/**
 * Detects a thenable result and attaches a rejection handler to it, so that work
 * the unit of work refuses (asynchronous callbacks) can never surface later as an
 * unhandled rejection. That covers a callback that rejects on its own and one
 * whose post-`await` repository call is rejected by the ownership guard.
 *
 * The thenable is not awaited. Its `then` property is read once and called once,
 * with a no-op rejection handler, so a custom thenable's rejection path is never
 * driven more than once by this code.
 *
 * A custom `then` may return a separate promise that rejects. When the returned
 * value is a native promise, a rejection handler is attached through the
 * intrinsic `Promise.prototype.then`, so neither the original thenable's `then`
 * nor any `then` overridden on the returned promise is invoked again (no
 * recursion). A non-promise return value cannot raise an `unhandledRejection`
 * event and is left untouched.
 *
 * Errors thrown while attaching handlers are ignored: the caller receives the
 * TypeError from `run` regardless.
 *
 * Returns true when `value` is a thenable.
 */
export function neutralizeThenable(value: unknown): boolean {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return false;
  }
  const then: unknown = (value as { then?: unknown }).then;
  if (typeof then !== 'function') {
    return false;
  }
  try {
    const returned: unknown = Reflect.apply(then, value, [undefined, ignoreRejection]);
    if (returned !== value && types.isPromise(returned)) {
      Reflect.apply(Promise.prototype.then, returned, [undefined, ignoreRejection]);
    }
  } catch {
    // A broken custom `then` cannot affect the outcome: the work is rejected anyway.
  }
  return true;
}
