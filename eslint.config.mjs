// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'eslint.config.mjs',
      'dist/**',
      'coverage/**',
      'src/database/migrations/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // supertest's response body is `any`; tests assert on it directly.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    // Business tables are reached only through TenantDatabase (tenant filter +
    // Row-Level Security). auth and health work across shops, so they may use
    // the raw Drizzle instance.
    files: ['src/modules/**/*.ts'],
    ignores: ['src/modules/auth/**', 'src/modules/health/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/database/database.module',
                '**/database/database.tokens',
              ],
              importNames: ['DRIZZLE'],
              message:
                'Do not use the raw Drizzle instance in a feature module. Inject TenantDatabase and use transaction(({ scoped, tx }) => ...) so every query is limited to the current shop.',
            },
          ],
        },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
);
