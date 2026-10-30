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
      //
      // auth-invite.ts is the same class of infra and exempt for the same reason: it reads and
      // writes Better Auth's OWN tables (`user`, `invitation`, `member`), which carry
      // `organization_id` rather than `household_id`, have no RLS policy, and are therefore not
      // what `withHousehold` scopes. Routing them through src/repo/* would mean a repository
      // that takes no household id, which is the opposite of what that layer means.
      //
      // Its TEST is deliberately NOT exempt: everything it needs goes through test/factories.ts,
      // which is outside this glob and already owns the suite's raw SQL. An exemption that
      // covered the test too would have grown the hole rather than kept it one file wide.
      files: ['apps/server/src/**/*.ts'],
      excludedFiles: [
        'apps/server/src/repo/**',
        'apps/server/src/db/**',
        'apps/server/src/auth.ts',
        'apps/server/src/auth-invite.ts',
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
