// Public API of src/adapters/sec/: production SEC transport and DNS adapters (task 19.2).
export {
  NO_REUSE_AGENT_OPTIONS,
  NoReuseAgent,
  createNodeSecTransport,
  defaultTlsOptions,
  pinnedLookup,
} from './nodeSecTransport.js';
export type { NodeSecTransportOptions, SecSocketFactory, SecSocketTarget } from './nodeSecTransport.js';
export { createNodeSecDnsResolver, toDnsFamilyAnswer } from './nodeSecDnsResolver.js';
export type { NodeSecDnsResolverOptions } from './nodeSecDnsResolver.js';
