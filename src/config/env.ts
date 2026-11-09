/**
 * Environment variables (R24.2, R24.3, R6.6). Secrets and personal data are read
 * only from the environment and never enter `AppConfig`, snapshots, logs, or API
 * responses. Provider credential names are vendor-neutral because no provider has
 * been selected yet (OD-5, OD-13).
 *
 * A missing or invalid `SEC_USER_AGENT` disables only SEC retrieval
 * (`SEC_CONFIG_MISSING`); everything else keeps running.
 */
import { z } from 'zod';

const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;

export const EnvSchema = z.object({
  /** Path of the runtime configuration file. The template is never accepted. */
  SRC_CONFIG_FILE: z.string().min(1).optional(),
  /**
   * Path of the SQLite database file (OD-12). Production start-up refuses to run without a
   * valid path; there is no in-memory fallback. `:memory:`, `file:` URIs, and control
   * characters are not accepted here (tests open `:memory:` explicitly).
   */
  SRC_DATABASE_FILE: z
    .string()
    .min(1)
    .refine((value) => value !== ':memory:' && !value.toLowerCase().startsWith('file:'), {
      message: 'must be a file path, not :memory: or a file: URI',
    })
    .refine((value) => ![...value].some((char) => (char.codePointAt(0) ?? 0) < 0x20), {
      message: 'must not contain control characters',
    })
    .optional(),
  /** SEC EDGAR User-Agent, including a contact email (personal data). */
  SEC_USER_AGENT: z
    .string()
    .trim()
    .min(1)
    .refine((value) => EMAIL_PATTERN.test(value), { message: 'must include a contact email address' })
    .optional(),
  MARKET_DATA_API_KEY: z.string().min(1).optional(),
  FX_API_KEY: z.string().min(1).optional(),
  SENTIMENT_API_KEY: z.string().min(1).optional(),
  NLP_API_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof EnvSchema>;
export type EnvKey = keyof Env;

export const ENV_KEYS = Object.keys(EnvSchema.shape) as EnvKey[];

/** Variables whose values are secret or personal and must always be redacted. */
export const SECRET_ENV_KEYS: readonly EnvKey[] = [
  'SEC_USER_AGENT',
  'MARKET_DATA_API_KEY',
  'FX_API_KEY',
  'SENTIMENT_API_KEY',
  'NLP_API_KEY',
];

export interface EnvIssue {
  readonly key: EnvKey;
  /** Validation message only; the value is never included. */
  readonly message: string;
}

export interface EnvLoadResult {
  /** Valid variables only. */
  readonly env: Env;
  readonly invalid: readonly EnvIssue[];
  readonly secRetrieval: {
    readonly available: boolean;
    readonly status: 'AVAILABLE' | 'SEC_CONFIG_MISSING';
    readonly missingKeys: readonly EnvKey[];
    readonly invalidKeys: readonly EnvKey[];
  };
  /** Exact secret values to pass to `redact()` and the logger. */
  readonly secrets: readonly string[];
}

export function loadEnv(source: Readonly<Record<string, string | undefined>>): EnvLoadResult {
  const env: Record<string, unknown> = {};
  const invalid: EnvIssue[] = [];
  for (const key of ENV_KEYS) {
    const raw = source[key];
    if (raw === undefined || raw.trim() === '') {
      continue;
    }
    const parsed = EnvSchema.shape[key].safeParse(raw);
    if (parsed.success) {
      env[key] = parsed.data;
    } else {
      invalid.push({ key, message: parsed.error.issues[0]?.message ?? 'invalid value' });
    }
  }

  const secrets: string[] = [];
  for (const key of SECRET_ENV_KEYS) {
    const raw = source[key]?.trim();
    if (raw !== undefined && raw !== '') {
      secrets.push(raw);
      if (key === 'SEC_USER_AGENT') {
        secrets.push(...raw.split(/\s+/).filter((token) => token.includes('@')));
      }
    }
  }

  const secInvalid = invalid.some((issue) => issue.key === 'SEC_USER_AGENT');
  const secMissing = !secInvalid && env['SEC_USER_AGENT'] === undefined;
  const secAvailable = !secInvalid && !secMissing;
  return {
    env: env as Env,
    invalid,
    secRetrieval: {
      available: secAvailable,
      status: secAvailable ? 'AVAILABLE' : 'SEC_CONFIG_MISSING',
      missingKeys: secMissing ? ['SEC_USER_AGENT'] : [],
      invalidKeys: secInvalid ? ['SEC_USER_AGENT'] : [],
    },
    secrets,
  };
}
