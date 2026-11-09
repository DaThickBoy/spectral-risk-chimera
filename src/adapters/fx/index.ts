// Public API of src/adapters/fx/: the ECB FX provider adapter (task 10.2; hackathon demo scope, H2).
export { ECB_CSV_HEADER, parseEcbCsv } from './ecbCsv.js';
export type { EcbCsvOptions, EcbCsvResult, EcbRow } from './ecbCsv.js';
export { ECB_CONVENTION_ID, ecbPublicationInstant, isCentralEuropeanSummerTime } from './ecbConvention.js';
export { ECB_ENDPOINT, createEcbFxProvider, ecbQueryUrl } from './ecbFxProvider.js';
export type { EcbFxProviderDependencies, EcbTransport } from './ecbFxProvider.js';
