/**
 * Helpers that read the structure of `ConfigSchema` and of raw configuration
 * objects. Used by the loader to validate keys one at a time.
 */
import { z } from 'zod';
import { UnsupportedNumber } from './jsonc.js';
import { ConfigSchema } from './schema.js';

function unwrapContainer(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    if (
      current instanceof z.ZodPrefault ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodOptional
    ) {
      current = current.unwrap() as z.ZodType;
    } else {
      return current;
    }
  }
}

/** The object shape of a (possibly defaulted or optional) object schema. */
export function objectShape(schema: z.ZodType): Readonly<Record<string, z.ZodType>> | undefined {
  const inner = unwrapContainer(schema);
  return inner instanceof z.ZodObject ? (inner.shape as Record<string, z.ZodType>) : undefined;
}

export const rootShape = (): Readonly<Record<string, z.ZodType>> =>
  ConfigSchema.shape as Record<string, z.ZodType>;

/** Leaf schemas of `ConfigSchema`, keyed by dotted path. */
export function configLeafSchemas(): ReadonlyMap<string, z.ZodType> {
  const leaves = new Map<string, z.ZodType>();
  const visit = (shape: Readonly<Record<string, z.ZodType>>, prefix: string): void => {
    for (const [name, child] of Object.entries(shape)) {
      const key = prefix === '' ? name : `${prefix}.${name}`;
      const childShape = objectShape(child);
      if (childShape === undefined) {
        leaves.set(key, child);
      } else {
        visit(childShape, key);
      }
    }
  };
  visit(rootShape(), '');
  return leaves;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof UnsupportedNumber)
  );
}

type Container = Record<string, unknown> | unknown[];

const isContainer = (value: unknown): value is Container => Array.isArray(value) || isPlainObject(value);

/**
 * Returns a copy of `value` with `null` object properties removed at every
 * depth (null is treated as absent). `null` array elements are kept so that
 * validation rejects them. Implemented with an explicit work stack instead of
 * recursion, so input of any depth cannot overflow the call stack.
 */
export function dropNulls(value: unknown): unknown {
  if (!isContainer(value)) {
    return value;
  }
  const work: [Container, Container][] = [];
  const copyOf = (source: Container): Container => {
    const target: Container = Array.isArray(source) ? [] : {};
    work.push([source, target]);
    return target;
  };
  const result = copyOf(value);
  for (let next = work.pop(); next !== undefined; next = work.pop()) {
    const [source, target] = next;
    if (Array.isArray(source) && Array.isArray(target)) {
      for (const item of source) {
        target.push(isContainer(item) ? copyOf(item) : item);
      }
    } else if (!Array.isArray(source) && !Array.isArray(target)) {
      for (const [key, item] of Object.entries(source)) {
        if (item !== null) {
          // defineProperty keeps keys such as "__proto__" as ordinary own properties.
          Object.defineProperty(target, key, {
            value: isContainer(item) ? copyOf(item) : item,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
    }
  }
  return result;
}

/** Collects unknown keys and groups that are present but are not objects. */
export function inspectStructure(
  raw: Record<string, unknown>,
  shape: Readonly<Record<string, z.ZodType>>,
  prefix: string,
  unknownKeys: string[],
  badGroups: string[],
): void {
  for (const [name, value] of Object.entries(raw)) {
    const key = prefix === '' ? name : `${prefix}.${name}`;
    const child = Object.prototype.hasOwnProperty.call(shape, name) ? shape[name] : undefined;
    if (child === undefined) {
      unknownKeys.push(key);
      continue;
    }
    const childShape = objectShape(child);
    if (childShape !== undefined) {
      if (isPlainObject(value)) {
        inspectStructure(value, childShape, key, unknownKeys, badGroups);
      } else {
        badGroups.push(key);
      }
    }
  }
}

/** Writes `value` at a dotted path, creating intermediate objects. */
export function setPath(target: Record<string, unknown>, key: string, value: unknown): void {
  const segments = key.split('.');
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (isPlainObject(next)) {
      current = next;
    } else {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    }
  }
  const last = segments[segments.length - 1];
  if (last !== undefined) {
    current[last] = value;
  }
}
