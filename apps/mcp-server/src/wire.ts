// apps/mcp-server/src/wire.ts
//
// Builds the real `ArchivistPort` from `@genesys-archivist/composition` --
// the composition root apps/mcp-server may depend on (apps import
// `application` and `composition` only; see eslint.config.mjs's `apps/**`
// rule). Every concrete adapter below is composition's own: a file-backed
// profile store, the OS/env secret store, the Platform API source-provider
// factory, and durable run persistence -- this file's only job is wiring
// them together and supplying the two things that genuinely have nowhere
// else to come from in this process (a config root, and process-wide
// defaults for the clock/id generator `createArchivistPort` otherwise
// defaults itself).
//
// `genesys_flow_diff` is wired to the real implementation:
// `@genesys-archivist/composition`'s `createDiffFlow` resolves both
// requested flow versions through the same `providerFor` closure
// `createArchivistPort` uses, normalizes each into a `FlowSnapshot`, and
// maps `diffSnapshots`'s result into the `FlowDiff` DTO. See
// `packages/composition/src/diff-flow.ts`'s header comment for the
// tenant-text policy every field of that mapping follows.
import { join } from 'node:path';
import type { ProfileId } from '@genesys-archivist/domain';
import {
  createArchivistPort,
  createDiffFlow,
  createGenesysProvider,
  createRunStore,
  defaultConfigRoot,
  openProfileStore,
  resolveSecretStore,
  type ArchivistPortDeps,
} from '@genesys-archivist/composition';
import type { ArchivistPort } from './port.js';

/** The exact shape `ArchivistPortDeps.secretStore` requires, recovered by
 * indexed access rather than importing `SecretStore` from
 * `@genesys-archivist/security` directly -- apps/* may not depend on
 * security (only application and composition), and this is the one place
 * that boundary would otherwise be tempting to cross. */
type SecretStoreShape = ArchivistPortDeps['secretStore'];

/**
 * Defers the real secret-store resolution (`resolveSecretStore`, which
 * probes the OS keyring) until the first secret operation actually runs,
 * memoizing the result -- so `buildRealPort` itself can stay synchronous,
 * matching `bin.ts`'s existing `const port = buildRealPort();` call site,
 * without ever needing to touch the keyring before a tool call that
 * actually requires it does.
 */
function createLazySecretStore(): SecretStoreShape {
  let resolved: Promise<SecretStoreShape> | undefined;
  const resolve = (): Promise<SecretStoreShape> => {
    resolved ??= resolveSecretStore();
    return resolved;
  };
  return {
    async get(profileId) {
      return (await resolve()).get(profileId);
    },
    async set(profileId, secret) {
      return (await resolve()).set(profileId, secret);
    },
    async has(profileId) {
      return (await resolve()).has(profileId);
    },
    async remove(profileId) {
      return (await resolve()).remove(profileId);
    },
  };
}

/**
 * Builds the port `bin.ts` wires into the real server.
 *
 * Every profile-scoped output (capture bundles, promoted documents) lands
 * under that profile's own `outputRoot`, per `createArchivistPort`'s
 * `executeRun`. Run *tracking* is deliberately rooted somewhere
 * profile-independent instead (`<configRoot>/runs`, alongside
 * `<configRoot>/profiles`): `genesys_docs_run_get`/`genesys_docs_run_cancel`
 * take a bare `runId` with no `profileId`, so this process needs exactly
 * one place to find any run's manifest regardless of which profile started
 * it -- see `ArchivistPortDeps.outputRoot`'s own doc comment in
 * archivist-port.ts for the longer version of why a profile's own
 * `outputRoot` would be the wrong root to use here.
 */
export function buildRealPort(): ArchivistPort {
  const configRoot = defaultConfigRoot();
  const profileStore = openProfileStore({ configRoot });
  const secretStore = createLazySecretStore();
  const runStore = createRunStore({ root: join(configRoot, 'runs') });
  // Shared by both createArchivistPort and createDiffFlow below, so a
  // profile's provider is resolved the same way (same secret store, same
  // config root) regardless of which of the two constructs it.
  const providerFor = (profileId: ProfileId) =>
    createGenesysProvider({ profileId, configRoot, secretStore });

  return createArchivistPort({
    profileStore,
    secretStore,
    runStore,
    providerFor,
    diffFlow: createDiffFlow({ providerFor }),
  });
}
