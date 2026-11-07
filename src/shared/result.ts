import type { AppError } from './errors.js';

/** Success or a typed error. Errors are values at module boundaries. */
export type Result<T, E extends AppError = AppError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function err<E extends AppError>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error };
}
