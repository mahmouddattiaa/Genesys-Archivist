import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve every `@genesys-archivist/*` import to that package's TypeScript
 * source rather than its build output.
 *
 * Without this, a cross-package import resolves through the workspace symlink
 * to `dist/index.js`, and `npm run verify` never builds: `typecheck` is
 * `tsc --build --dry`, which emits nothing. The suite therefore ran against
 * whatever `dist` happened to be lying around — green on a machine that had
 * built once, and green even when `src` and `dist` had drifted apart. A test
 * that passes because of a stale artifact is not evidence of anything.
 *
 * Built by scanning the workspace so a new package is wired up by existing,
 * not by remembering to edit this list.
 */
const workspaceAliases: Record<string, string> = {};
for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const source = join(root, 'packages', entry.name, 'src', 'index.ts');
  if (existsSync(source)) workspaceAliases[`@genesys-archivist/${entry.name}`] = source;
}

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/index.ts', '**/*.d.ts'],
    },
  },
});
