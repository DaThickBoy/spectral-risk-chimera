// ESLint flat config (task 1.3; R4.2, R4.4, R27.13; financial-rules 1, 2, 7).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Financial modules: no native-number parsing or arithmetic helpers (R4.2). */
export const FINANCIAL_MODULE_FILES = [
  'src/risk/**/*.ts',
  'src/portfolio/**/*.ts',
  'src/fx/**/*.ts',
  'src/ingestion/**/*.ts',
];

const DECIMAL_CONSTRUCTION = [
  {
    selector: "NewExpression[callee.name='Decimal']",
    message: 'Construct Decimal values only with d() from src/shared/decimal.ts (financial-rules 1).',
  },
  {
    selector: "NewExpression[callee.name='DEC']",
    message: 'Construct Decimal values only with d() from src/shared/decimal.ts (financial-rules 1).',
  },
];

const CHART_NUMBER_IMPORT = [
  {
    selector: "ImportSpecifier[imported.name='toChartNumber']",
    message: 'toChartNumber may be imported only by src/web/chartAdapter.ts (R4.4).',
  },
  {
    selector: "ExportSpecifier[local.name='toChartNumber']",
    message: 'toChartNumber may be re-exported only by src/shared/ (R4.4).',
  },
];

const NATIVE_NUMBER_SYNTAX = [
  {
    selector: "CallExpression[callee.name='Number']",
    message: 'Number() is forbidden on financial values; use d() (R4.2).',
  },
  {
    selector: "UnaryExpression[operator='+']",
    message: 'Unary + is forbidden on financial values; use d() (R4.2).',
  },
  {
    selector: "MemberExpression[object.name='Math']",
    message: 'Math.* is forbidden in financial modules; use Decimal methods (R4.2).',
  },
  {
    selector: "MemberExpression[object.name='Number'][property.name='parseFloat']",
    message: 'Number.parseFloat is forbidden on financial values; use d() (R4.2).',
  },
];

/**
 * Gateway rule 9: production code listens only through `listenApiServer`, which refuses a
 * server built without the Host and Origin request guard. Calls only (`x.listen(...)`,
 * `x?.listen(...)`, `x['listen'](...)`); reading a `listen` option is not a call.
 */
const LISTEN_CALL = [
  {
    selector: "CallExpression > MemberExpression.callee[property.name='listen']",
    message:
      'Call .listen() only in src/api/server.ts; use listenApiServer so the request guard is enforced (Gateway rule 9).',
  },
  {
    selector: "CallExpression > MemberExpression.callee[property.value='listen']",
    message:
      'Call .listen() only in src/api/server.ts; use listenApiServer so the request guard is enforced (Gateway rule 9).',
  },
];

/** Production code: everything under src/ except the guarded listen entry point. */
const PRODUCTION_FILES = ['src/**/*.ts', 'src/**/*.tsx'];
const LISTEN_ENTRY_POINT = 'src/api/server.ts';

const DECIMAL_CLONE = {
  object: 'Decimal',
  property: 'clone',
  message: 'Decimal.clone is allowed only in src/shared/decimal.ts (financial-rules 1).',
};

const DECIMAL_JS_IMPORT = {
  paths: [
    {
      name: 'decimal.js',
      allowTypeImports: true,
      message: 'Import Decimal helpers from src/shared/ instead of decimal.js (financial-rules 1).',
    },
  ],
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'test/fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': 'allow-with-description' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'separate-type-imports' }],
      'no-restricted-syntax': ['error', ...DECIMAL_CONSTRUCTION, ...CHART_NUMBER_IMPORT],
      'no-restricted-properties': ['error', DECIMAL_CLONE],
      '@typescript-eslint/no-restricted-imports': ['error', DECIMAL_JS_IMPORT],
    },
  },
  {
    // Gateway rule 9: no direct .listen() in production code outside the guarded entry point.
    // Later src/ blocks replace no-restricted-syntax, so each of them repeats LISTEN_CALL.
    files: PRODUCTION_FILES,
    ignores: [LISTEN_ENTRY_POINT],
    rules: {
      'no-restricted-syntax': ['error', ...DECIMAL_CONSTRUCTION, ...CHART_NUMBER_IMPORT, ...LISTEN_CALL],
    },
  },
  {
    files: FINANCIAL_MODULE_FILES,
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'parseFloat is forbidden on financial values; use d() (R4.2).' },
      ],
      'no-restricted-syntax': [
        'error',
        ...DECIMAL_CONSTRUCTION,
        ...CHART_NUMBER_IMPORT,
        ...NATIVE_NUMBER_SYNTAX,
        ...LISTEN_CALL,
      ],
    },
  },
  {
    // Dashboard (architecture rule 4): no financial calculation in web/. Native-number parsing
    // and Math are forbidden; values are rendered as backend text. Decimal.js is not imported.
    files: ['src/web/**/*.ts', 'src/web/**/*.tsx'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'No numeric parsing in the dashboard; render backend text (architecture 4).',
        },
        {
          name: 'parseInt',
          message: 'No numeric parsing in the dashboard; render backend text (architecture 4).',
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...DECIMAL_CONSTRUCTION,
        ...CHART_NUMBER_IMPORT,
        ...NATIVE_NUMBER_SYNTAX,
        ...LISTEN_CALL,
      ],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'decimal.js',
              message: 'The dashboard never computes financial values (architecture 4).',
            },
          ],
        },
      ],
    },
  },
  {
    // The Decimal helper is the only place that configures and constructs Decimal.js.
    files: ['src/shared/decimal.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...CHART_NUMBER_IMPORT, ...LISTEN_CALL],
      'no-restricted-properties': 'off',
      '@typescript-eslint/no-restricted-imports': 'off',
    },
  },
  {
    // The shared public API re-exports toChartNumber; the chart adapter consumes it.
    files: ['src/shared/index.ts', 'src/web/chartAdapter.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...DECIMAL_CONSTRUCTION, ...LISTEN_CALL],
    },
  },
  {
    // The Decimal helper's own unit test exercises toChartNumber.
    files: ['test/unit/shared/decimal.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...DECIMAL_CONSTRUCTION],
    },
  },
);
