// dependency-cruiser module boundaries (task 1.4; architecture.md section 2; R11.5, R26.1, R26.2, R26.10).
//
// Allowed project-internal imports per module (architecture.md module table).
// A module may always import its own files.
const ALLOWED = {
  shared: [],
  config: ['shared'],
  audit: ['shared', 'persistence-ports'],
  ingestion: ['shared', 'config', 'audit', 'portfolio', 'persistence-ports'],
  portfolio: ['shared', 'config'],
  marketdata: ['shared', 'config'],
  fx: ['shared', 'config'],
  sec: ['shared', 'config'],
  nlp: ['shared', 'config'],
  sentiment: ['shared', 'config'],
  risk: ['shared', 'config', 'portfolio', 'marketdata', 'fx', 'sentiment'],
  alerts: ['shared', 'config', 'risk', 'sec'],
};

const DOMAIN = Object.keys(ALLOWED);
const DOMAIN_GROUP = `(${DOMAIN.join('|')})`;

const toPath = (target) =>
  target === 'persistence-ports' ? '^src/persistence/ports\\.ts$' : `^src/${target}/`;

const moduleRules = Object.entries(ALLOWED).map(([module, allowed]) => ({
  name: `boundary-${module}`,
  comment: `src/${module}/ may import only: ${allowed.length === 0 ? 'nothing project-internal' : allowed.join(', ')}.`,
  severity: 'error',
  from: { path: `^src/${module}/` },
  to: {
    path: '^src/',
    pathNot: [`^src/${module}/`, ...allowed.map(toPath)],
  },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'risk-not-to-sec-or-nlp',
      comment: 'FilingRiskScore never reaches the risk engine (R11.5): risk/ must not import sec/ or nlp/.',
      severity: 'error',
      from: { path: '^src/risk/' },
      to: { path: '^src/(sec|nlp)/' },
    },
    {
      name: 'domain-not-to-outer-layers',
      comment: 'Domain modules never import adapters/, persistence implementations, app/, api/, or web/.',
      severity: 'error',
      from: { path: `^src/${DOMAIN_GROUP}/` },
      to: { path: '^src/(adapters|app|api|web|persistence)/', pathNot: '^src/persistence/ports\\.ts$' },
    },
    {
      name: 'web-not-to-domain',
      comment: 'web/ talks to the backend only through API contracts; it may import src/shared/ only.',
      severity: 'error',
      from: { path: '^src/web/' },
      to: { path: '^src/', pathNot: ['^src/web/', '^src/shared/'] },
    },
    {
      name: 'outer-layers-not-to-web',
      comment: 'Only web/ contains dashboard code; no other module imports it.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/web/' },
      to: { path: '^src/web/' },
    },
    {
      name: 'api-only-app-and-shared',
      comment: 'api/ uses app/ services and shared API contracts only.',
      severity: 'error',
      from: { path: '^src/api/' },
      to: { path: '^src/', pathNot: ['^src/api/', '^src/app/', '^src/shared/'] },
    },
    {
      name: 'adapters-not-to-app-or-api',
      comment: 'persistence/ and adapters/ implement ports; they do not import app/ or api/.',
      severity: 'error',
      from: { path: '^src/(adapters|persistence)/' },
      to: { path: '^src/(app|api)/' },
    },
    {
      name: 'cross-module-through-index',
      comment: 'Import another module through its index.ts public API, never its internal files.',
      severity: 'error',
      from: { path: '^src/([^/]+)/' },
      to: {
        path: '^src/[^/]+/',
        pathNot: ['^src/$1/', '^src/[^/]+/index\\.ts$', '^src/persistence/ports\\.ts$'],
      },
    },
    ...moduleRules,
    {
      name: 'no-unresolvable',
      comment: 'Every import must resolve, so boundary rules cannot be bypassed by resolution failures.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      comment: 'No circular dependencies between source files.',
      severity: 'error',
      from: { path: '^src/' },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|test)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.mjs', '.cjs', '.d.ts'],
    },
  },
};
