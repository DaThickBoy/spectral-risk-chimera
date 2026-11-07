// AT-CFG-02 and EnvSchema (task 3.4): secrets come from the environment only.
// Validates: Requirements 24.2, 24.3, 24.4, 6.6
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, ENV_KEYS, loadEnv } from '../../../src/config/index.js';
import { repoPath, runGit } from '../../helpers/repo.js';

const FAKE_KEY = 'test-api-key';
const FAKE_AGENT = 'Example Research ops@example.invalid';

describe('AT-CFG-02: .env.example and .env', () => {
  const lines = readFileSync(repoPath('.env.example'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));

  it('lists every EnvSchema variable with a placeholder or empty value only', () => {
    const entries = lines.map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)] as const;
    });
    expect(entries.map(([key]) => key).sort()).toEqual([...ENV_KEYS].sort());
    for (const [key, value] of entries) {
      const placeholder = value === '' || /^(<[a-z0-9-]+>)( <[a-z0-9-]+>)*$/.test(value);
      expect(placeholder, `${key} must hold a placeholder`).toBe(true);
    }
  });

  it('keeps .env out of Git and .env.example in Git', () => {
    expect(runGit(['check-ignore', '-q', '.env']).code).toBe(0);
    expect(runGit(['check-ignore', '-q', '.env.local']).code).toBe(0);
    expect(runGit(['check-ignore', '-q', '.env.example']).code).toBe(1);
  });
});

describe('loadEnv', () => {
  it('reads valid variables and collects secret values for redaction', () => {
    const result = loadEnv({
      SRC_CONFIG_FILE: 'runtime.jsonc',
      SEC_USER_AGENT: FAKE_AGENT,
      FX_API_KEY: FAKE_KEY,
      PATH: 'x',
    });
    expect(result.env).toEqual({
      SRC_CONFIG_FILE: 'runtime.jsonc',
      SEC_USER_AGENT: FAKE_AGENT,
      FX_API_KEY: FAKE_KEY,
    });
    expect(result.secRetrieval).toEqual({
      available: true,
      status: 'AVAILABLE',
      missingKeys: [],
      invalidKeys: [],
    });
    expect(result.secrets).toEqual([FAKE_AGENT, 'ops@example.invalid', FAKE_KEY]);
  });

  it('a missing SEC_USER_AGENT disables only SEC retrieval', () => {
    for (const value of [undefined, '', '   ']) {
      const result = loadEnv({ SEC_USER_AGENT: value, FX_API_KEY: FAKE_KEY });
      expect(result.secRetrieval).toEqual({
        available: false,
        status: 'SEC_CONFIG_MISSING',
        missingKeys: ['SEC_USER_AGENT'],
        invalidKeys: [],
      });
      expect(result.env.FX_API_KEY).toBe(FAKE_KEY);
    }
  });

  it('an SEC_USER_AGENT without a contact email is invalid, and its value is never echoed', () => {
    const result = loadEnv({ SEC_USER_AGENT: 'Example Research' });
    expect(result.secRetrieval).toMatchObject({ available: false, invalidKeys: ['SEC_USER_AGENT'] });
    expect(JSON.stringify(result.invalid)).not.toContain('Example Research');
    expect(result.secrets).toContain('Example Research');
  });

  it('secrets never enter AppConfig', () => {
    const shape = ConfigSchema.shape;
    expect(Object.keys(shape.sec.unwrap().shape)).not.toContain('userAgent');
    expect(JSON.stringify(Object.keys(shape))).not.toMatch(/apiKey|secret|token/i);
  });
});
