// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint configuration.
 *
 * Type-aware rules are on, because the mistakes that matter in this codebase
 * are type-shaped: a floating promise in a Twilio webhook silently drops a
 * compliance write, and an unawaited `evaluateGate` is truthy, which would make
 * every call "authorized".
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'dist/**',
      'out/**',
      'coverage/**',
      // Build config lives outside the tsconfig project graph; type-aware
      // linting cannot parse it and has nothing useful to say about it.
      '*.config.js',
      '*.config.mjs',
      'vitest.config.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // An unawaited promise in a webhook handler drops the write and returns
      // 200. The single most costly mistake shape in this repo.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // `evaluateGate(...)` unawaited is a truthy Promise — it would read as a
      // successful authorization.
      '@typescript-eslint/await-thenable': 'error',
      // require-await is deliberately OFF: async methods that satisfy an
      // interface (DncProvider, SynthesisPort) legitimately have nothing to
      // await, and the rule's noise there buries findings that matter.
      '@typescript-eslint/require-await': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The compliance layer casts through `unknown` to brand authorizations;
      // that is the mechanism, not an accident.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },

  {
    files: ['**/*.test.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
