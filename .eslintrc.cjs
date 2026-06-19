module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, browser: true, es2022: true },
  ignorePatterns: ['dist', 'node_modules', '*.config.*'],
  overrides: [
    {
      // Domain access must go through the household-scoped repository layer, never
      // raw Drizzle from routers/services — otherwise tenant scoping can be bypassed.
      // The db/repo layers own the client; auth.ts is infra that wires Better Auth to it.
      files: ['apps/server/src/**/*.ts'],
      excludedFiles: [
        'apps/server/src/repo/**',
        'apps/server/src/db/**',
        'apps/server/src/auth.ts',
      ],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/db/client'],
                message: 'Domain access must go through src/repo/* (household-scoped).',
              },
            ],
          },
        ],
      },
    },
  ],
};
