/**
 * Spectral Risk Chimera entry point.
 *
 * Phase 1 provides foundations only: it reads the environment, creates the
 * redacting logger, loads the runtime configuration, and logs which features
 * are available. Missing or invalid settings never stop the process; they
 * disable only the dependent features (Configuration policy 1 and 6).
 * Application services are assembled in later phases.
 */
import { pathToFileURL } from 'node:url';
import { loadConfig, loadEnv } from './config/index.js';
import type { ConfigLoadResult, EnvLoadResult } from './config/index.js';
import { createLogger, systemClock } from './shared/index.js';
import type { Clock, Logger } from './shared/index.js';

export interface FoundationStartOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock?: Clock;
  readonly sink?: (line: string) => void;
  readonly templatePath?: string;
}

export interface FoundationState {
  readonly env: EnvLoadResult;
  readonly config: ConfigLoadResult;
  readonly logger: Logger;
}

export function startFoundation(options: FoundationStartOptions): FoundationState {
  const env = loadEnv(options.env);
  const logger = createLogger({
    clock: options.clock ?? systemClock,
    secrets: env.secrets,
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  });
  if (env.invalid.length > 0) {
    logger.warn('env.invalid', {
      keys: env.invalid.map((issue) => ({ key: issue.key, message: issue.message })),
    });
  }
  logger.info('env.sec_retrieval', env.secRetrieval);
  const config = loadConfig({
    srcConfigFile: env.env.SRC_CONFIG_FILE,
    logger,
    ...(options.templatePath === undefined ? {} : { templatePath: options.templatePath }),
  });
  return { env, config, logger };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  startFoundation({ env: process.env });
}
