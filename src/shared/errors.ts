/**
 * Typed application errors. Domain and adapter functions return these inside a
 * `Result`; exceptions are reserved for programmer errors (design: Error Handling).
 * Each module declares its own error-code union, for example `ConfigErrorCode`.
 */
export interface AppError<C extends string = string> {
  readonly code: C;
  /** Short message without secrets or personal data. */
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function appError<C extends string>(
  code: C,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AppError<C> {
  return details === undefined ? { code, message } : { code, message, details };
}

/** Exhaustiveness guard for discriminated-union switches. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}
