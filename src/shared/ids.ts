import { randomUUID } from 'node:crypto';

/** Source of unique identifiers, injectable so tests are deterministic. */
export interface IdGenerator {
  next(): string;
}

/** Random RFC 4122 version 4 UUIDs. */
export const randomIds: IdGenerator = {
  next: () => randomUUID(),
};

/** Deterministic identifiers for tests: `<prefix>-1`, `<prefix>-2`, ... */
export function sequentialIds(prefix: string): IdGenerator {
  let counter = 0;
  return {
    next: () => {
      counter += 1;
      return `${prefix}-${counter}`;
    },
  };
}

/** A new correlation id for logs and client error bodies. */
export function newCorrelationId(): string {
  return randomUUID();
}
