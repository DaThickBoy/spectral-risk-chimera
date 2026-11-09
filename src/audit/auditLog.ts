/**
 * Append-only audit log (task 5.2; design: Quarantine and Audit Log; R22.6, R3.3).
 *
 * - `AuditLog` has exactly one operation, `append(event)`. There is no update,
 *   delete, or read API; reading entries is a persistence concern
 *   (`AuditRepo.list`). Stored entries are immutable (task 5.1).
 * - An audit log is bound to the `AuditRepo` of one unit of work, so an entry is
 *   committed or rolled back together with the other writes of that unit of work
 *   (for example an import's rows and its rejection audit entries, R28.15).
 * - `recordAuditEvent` writes one entry in its own unit of work, for events that
 *   must survive a rolled-back transaction (design: `IMPORT_FAILED` is recorded
 *   "afterwards in a separate audit write").
 * - Every event is validated (`AuditEventSchema`): a non-empty id, a timestamp in
 *   the persisted `IsoUtc` form `YYYY-MM-DDTHH:mm:ss.sssZ` checked by the shared
 *   `IsoUtcMillis` schema (as `Date.prototype.toISOString` produces from the
 *   injected `Clock`; the same check every persistence adapter applies), one of
 *   the design's categories, a non-empty type, and
 *   details whose values are strings or booleans only (no native-number money).
 *   An invalid event is a programmer error and throws `AuditEventError`; nothing
 *   is written.
 * - Before storage, the details and the free-text fields (`type`, `subject`,
 *   `actor`) pass through `redact()` with the configured secrets, so credentials,
 *   authorization headers, sensitive keys, and FIX `Account` values are never
 *   stored (R22.6 "without sensitive data", R24.7, R29.12).
 * - If two or more detail keys become the same key after redaction, the event is
 *   rejected with `AuditEventError` (reason `REDACTED_KEY_COLLISION`, field
 *   `details`) instead of letting one value silently overwrite another. Nothing is
 *   written; see `redactEvent`.
 */
import { z } from 'zod';
import type { AuditCategory, AuditRecord, AuditRepo, UnitOfWork } from '../persistence/ports.js';
import { IsoUtcMillis, redact, redactText } from '../shared/index.js';

/** The design's audit categories. */
export const AUDIT_CATEGORIES = [
  'IMPORT',
  'VALIDATION',
  'PROVIDER',
  'CALCULATION',
  'ALERT',
  'CONFIG',
  'SECURITY',
] as const satisfies readonly AuditCategory[];

export const AuditEventSchema = z.strictObject({
  id: z.string().min(1),
  // The persisted IsoUtc contract (shared `isIsoUtcMillis`): YYYY-MM-DDTHH:mm:ss.sssZ.
  at: IsoUtcMillis,
  category: z.enum(AUDIT_CATEGORIES),
  type: z.string().min(1),
  subject: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  details: z.record(z.string(), z.union([z.string(), z.boolean()])),
});

/** An audit event (design: `AuditEvent`). Structurally identical to the stored `AuditRecord`. */
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** The only audit operation (design: `AuditLog`). */
export interface AuditLog {
  append(event: AuditEvent): void;
}

export interface AuditLogOptions {
  /** Exact secret values to remove (for example from `loadEnv(...).secrets`). */
  readonly secrets?: readonly string[];
}

/**
 * Why an audit event was rejected: it failed `AuditEventSchema`, or two or more
 * of its detail keys become the same key after redaction.
 */
export type AuditEventErrorReason = 'INVALID_EVENT' | 'REDACTED_KEY_COLLISION';

/** Thrown for an invalid audit event. Only field paths are reported, never keys or values. */
export class AuditEventError extends Error {
  readonly fields: readonly string[];
  readonly reason: AuditEventErrorReason;

  constructor(fields: readonly string[], reason: AuditEventErrorReason = 'INVALID_EVENT') {
    const suffix = reason === 'REDACTED_KEY_COLLISION' ? ' (detail keys collide after redaction)' : '';
    super(`Invalid audit event: ${fields.join(', ')}${suffix}.`);
    this.name = 'AuditEventError';
    this.fields = fields;
    this.reason = reason;
  }
}

function validate(event: unknown): AuditEvent {
  const parsed = AuditEventSchema.safeParse(event);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(event)'))];
    throw new AuditEventError(fields);
  }
  return parsed.data;
}

/**
 * Redacts the free-text fields and details of a validated event.
 *
 * Collision detection: `redact()` rewrites each detail key with `redactText()`,
 * so distinct original keys can map to the same redacted key (for example two
 * keys that each consist of a different configured secret both become
 * `[REDACTED]`), and the later value would silently replace the earlier one.
 * Details are flat (string or boolean values only), so every original key yields
 * exactly one own key in the redacted copy unless keys merged. The check
 * therefore compares the own-key count of the actual `redact()` output with the
 * own-key count of the validated input; any shortfall means information would be
 * lost, and the event is rejected before anything is written. Comparing the real
 * output, rather than re-deriving redacted keys here, keeps the check exact for
 * whatever key transformation `redact()` applies. The error names only the
 * `details` field, never an original key, a redacted key, or a value.
 */
function redactEvent(event: AuditEvent, secrets: readonly string[]): AuditRecord {
  const details = redact(event.details, { secrets }) as Record<string, string | boolean>;
  if (Object.keys(details).length !== Object.keys(event.details).length) {
    throw new AuditEventError(['details'], 'REDACTED_KEY_COLLISION');
  }
  return {
    id: event.id,
    at: event.at,
    category: event.category,
    type: redactText(event.type, secrets),
    ...(event.subject === undefined ? {} : { subject: redactText(event.subject, secrets) }),
    ...(event.actor === undefined ? {} : { actor: redactText(event.actor, secrets) }),
    details,
  };
}

/**
 * An append-only audit log over the `AuditRepo` of one unit of work. Use it only
 * inside that unit of work's `run`.
 */
export function createAuditLog(repo: AuditRepo, options: AuditLogOptions = {}): AuditLog {
  const secrets = options.secrets ?? [];
  return {
    append: (event) => {
      // Validation and collision detection both happen before `repo.append`.
      repo.append(redactEvent(validate(event), secrets));
    },
  };
}

/** Appends one event in its own unit of work, independent of any other transaction. */
export function recordAuditEvent(uow: UnitOfWork, event: AuditEvent, options: AuditLogOptions = {}): void {
  // Validate and redact (including collision detection) before opening the unit
  // of work, so an invalid or colliding event opens nothing. The record is
  // redacted exactly once.
  const record = redactEvent(validate(event), options.secrets ?? []);
  uow.run((tx) => {
    tx.audit.append(record);
  });
}
