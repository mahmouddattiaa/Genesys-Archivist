import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Architectural boundaries from the design spec, section 4.2, enforced as lint
 * rules rather than left to reviewer discipline.
 *
 *   domain       imports nothing from this repo, and performs no I/O
 *   application  imports domain only
 *   apps/*       import application and composition only
 *
 * Type-aware rules resolve through tsconfig.eslint.json rather than the build
 * tsconfigs, because each package's build config includes only src/ — test files
 * must be lintable without being emitted into dist/.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },

  js.configs.recommended,

  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
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
              // domain must perform no I/O. node:crypto is deliberately permitted:
              // canonical hashing and derived node identity are pure computation,
              // and reimplementing SHA-256 by hand would be strictly worse.
              group: [
                'node:fs',
                'node:fs/*',
                'node:path',
                'node:os',
                'node:http',
                'node:https',
                'node:net',
                'node:dns',
                'node:child_process',
                'node:process',
                'node:worker_threads',
                'fs',
                'fs/*',
                'path',
                'os',
                'http',
                'https',
                'net',
                'dns',
                'child_process',
              ],
              message:
                'domain must be pure: no filesystem, network, process, or OS access. node:crypto is permitted.',
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
    // Tests deliberately handle untyped JSON, poke at private shapes, and use
    // non-null assertions on fixtures they just constructed. The type-safety
    // rules that protect production code get in the way here without catching
    // anything real.
    files: ['**/test/**/*.ts'],
    rules: {
      'no-console': 'off',
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      // Tests routinely hand JSON.parse output straight to a helper. The other
      // no-unsafe-* rules were already off here; omitting this one was an
      // oversight that forced test code to be contorted for no safety gain.
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          // Permits the destructure-to-omit idiom:
          //   const { contentHash: _omitted, ...withoutHash } = manifest;
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
        },
      ],
    },
  },

  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        structuredClone: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        AbortController: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
      ],
    },
  },
);
