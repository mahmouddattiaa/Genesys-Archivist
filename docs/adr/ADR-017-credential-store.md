# ADR-017: OS credential store via `@napi-rs/keyring`, injected behind `KeyringBackend`

Date: 2026-08-20
Status: accepted
Deciders: Plan 2, Task 1 (packages/security)

## Context

Genesys Cloud credentials (OAuth client secret, or any other bearer material
a profile needs) must never be stored in plaintext on disk, never appear in
an MCP tool argument, and must survive a `profile add` / `archivist capture`
round trip across Windows, macOS, and Linux developer machines, plus Linux
CI runners that have no desktop session and no `gnome-keyring` daemon.

`AGENTS.md` and `CLAUDE.md` both make this non-negotiable: no credential in
any log, manifest, snapshot, document, fixture, exception, or telemetry
field, and `profile add` stays CLI-only forever.

The store also has to be unit-testable without a real keyring daemon,
because CI has none.

## Options considered

1. **`@napi-rs/keyring`** — Rust-backed OS keyring bindings shipping
   prebuilt native binaries per platform/arch (`keyring-win32-x64-msvc` on
   this machine). No `node-gyp`, no compiler toolchain, no build step on
   install.
2. **Shell out to platform tools** — PowerShell `CredentialManager` module
   on Windows, `security` CLI on macOS, `secret-tool` on Linux. Zero npm
   dependencies, but three separate code paths to write and test, three sets
   of quoting/escaping hazards for secret values passed as process arguments
   (which risks exactly the "secret in an argument" failure this task exists
   to prevent — shell args can leak via process listings), and a runtime
   dependency on tools that may not be installed (`secret-tool` requires
   `libsecret-tools` on many Linux distros).
3. **`keytar`** — explicitly excluded by the plan: archived and unmaintained
   upstream, no npm updates against current Node/Electron ABI versions.

## Decision

Chose **`@napi-rs/keyring@1.3.0`**.

Proof performed on this machine (Windows 11, Node 22.15.0) before writing
any production code:

```
npm install --workspace @genesys-archivist/security @napi-rs/keyring
node --input-type=module -e "import{Entry}from'@napi-rs/keyring';const e=new Entry('archivist-probe','probe');e.setPassword('ok');console.log('roundtrip:',e.getPassword()==='ok');e.deletePassword();"
```

Result: `npm install` pulled the platform-specific binary package
(`@napi-rs/keyring-win32-x64-msvc`) with no compilation step, and the
round-trip printed `roundtrip: true`. Option 1 passed the plan's stated bar
("first that works on Windows, macOS, and Linux without a compiler
toolchain") on the first platform tested, so option 2 was not implemented.

The dependency is not used directly by production code: it is wired only
inside `createOsSecretStore()`'s backend factory in
`packages/security/src/secret-store-os.ts`, behind the `KeyringBackend`
interface defined in `packages/security/src/keyring.ts`. Every other
consumer — including all tests — depends on `KeyringBackend`, not on
`@napi-rs/keyring` directly.

## Consequences

- **Easy:** unit testing `OsSecretStore` with an in-memory fake
  `KeyringBackend`; no keyring daemon required in CI. Swapping the backend
  later (e.g. to the shell-out approach for a platform where the native
  binary is unavailable) means writing one new `KeyringBackend`
  implementation, not touching `OsSecretStore` or its call sites.
- **Hard:** the native binary is per-platform/arch. If a future target
  platform has no prebuilt `@napi-rs/keyring-*` package, the install step
  fails on that platform specifically; this is caught at `npm install` time,
  not silently at runtime, since npm's optional-dependency resolution picks
  the matching binary or fails visibly.
- **Forecloses:** using `keytar` (explicitly ruled out — archived) and
  reintroducing a `node-gyp` build step for credential storage.
