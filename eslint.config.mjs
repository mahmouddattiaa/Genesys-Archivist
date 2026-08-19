import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Architectural boundaries from the design spec, section 4.2, enforced as lint
 * rules rather than left to reviewer discipline.
 *
 *   domain       imports nothing from this repo, and touches no I/O
 *   application  imports domain only
 *   apps/*       import application only
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },

  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@genesys-archivist/*'],
              message: 'domain must not import other workspace packages.',
            },
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'child_process'],
              message: 'domain must be pure: no I/O, no filesystem, no network.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['packages/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@genesys-archivist/*', '!@genesys-archivist/domain'],
              message:
                'application may import only @genesys-archivist/domain. Depend on interfaces, not adapters.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['apps/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@genesys-archivist/genesys-*',
                '@genesys-archivist/capture',
                '@genesys-archivist/normalization',
                '@genesys-archivist/analysis',
                '@genesys-archivist/documentation',
                '@genesys-archivist/rendering',
                '@genesys-archivist/narrative',
              ],
              message: 'Adapters are thin. Go through @genesys-archivist/application.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/test/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
