/**
 * Structured JSON logger. Every record passes through `redact()` before it is
 * written (R24.7, R29.12). Each logger carries a correlation id.
 */
import type { Clock } from './clock.js';
import { newCorrelationId } from './ids.js';
import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  readonly correlationId: string;
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
  /** A logger with extra bindings; pass `correlationId` to override it. */
  child(bindings: Readonly<Record<string, unknown>> & { readonly correlationId?: string }): Logger;
}

export interface LoggerOptions {
  readonly clock: Clock;
  /** Receives one JSON line per record. Defaults to standard output. */
  readonly sink?: (line: string) => void;
  /** Exact secret values to redact (for example from the environment). */
  readonly secrets?: readonly string[];
  readonly level?: LogLevel;
  readonly correlationId?: string;
  readonly bindings?: Readonly<Record<string, unknown>>;
}

const defaultSink = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? defaultSink;
  const secrets = options.secrets ?? [];
  const minLevel = LEVEL_ORDER[options.level ?? 'info'];
  const correlationId = options.correlationId ?? newCorrelationId();
  const bindings = options.bindings ?? {};

  const write = (level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void => {
    if (LEVEL_ORDER[level] < minLevel) {
      return;
    }
    const record = redact(
      {
        ...bindings,
        ...fields,
        time: options.clock.nowUtc().toISOString(),
        level,
        msg: message,
        correlationId,
      },
      { secrets },
    );
    sink(JSON.stringify(record));
  };

  return {
    correlationId,
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (childBindings) => {
      const { correlationId: childId, ...rest } = childBindings;
      return createLogger({
        ...options,
        correlationId: childId ?? correlationId,
        bindings: { ...bindings, ...rest },
      });
    },
  };
}
