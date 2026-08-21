# Contributing to Genesys Archivist

This project is open to outside development. If you want to extend it — new flow-node
coverage, better documents, the migration server that consumes its bundles, a fix for
something on the known-gaps list — **fork the repository, work on a branch, and open a
pull request.** Every PR is reviewed before it is merged.

You do not need access to a Genesys organisation to contribute usefully. The entire
documentation stage, and most of capture, is testable offline against fixtures.

---

## The workflow

```bash
# 1. Fork on GitHub, then:
git clone https://github.com/<you>/<fork>.git
cd <fork>
npm install

# 2. Branch
git checkout -b fix/unsupported-node-warning

# 3. Work, with the suite running
npm run test:watch

# 4. The gate. Run this before every commit -- CI runs the same thing.
npm run verify

# 5. Push and open a PR against `main`
git push -u origin fix/unsupported-node-warning
```

`npm run verify` is `format:check` + `lint` + `typecheck` (production **and** test
sources) + the full test suite + JSON Schema validation. A PR that does not pass it
cannot be reviewed properly, so please do not open one that does not.

---

## Read these first

Three documents, in order. They are short, and skipping them is the main reason a PR
gets sent back.

1. **[AGENTS.md](AGENTS.md)** — the non-negotiable boundaries. Violating one is a
   release-blocking security failure, not a style disagreement.
2. **[CLAUDE.md](CLAUDE.md)** — how the codebase is organised and what the current state
   actually is, including what is known to be broken.
3. **[The design spec](docs/superpowers/specs/2026-08-20-genesys-archivist-design.md)** —
   what is being built and why, and where it deliberately departs from the numbered
   blueprint documents in `docs/`.

---

## The five rules that will get a PR rejected

These are not preferences. Each one exists because this tool authenticates against a
customer's contact-centre platform and reads configuration that may contain personal
data.

1. **No credential in any MCP tool argument, log, manifest, snapshot, document, fixture,
   exception, or telemetry field.** Provisioning is CLI-only, permanently — MCP tool
   arguments are chat-visible and client-logged.
2. **Read-only against Genesys.** No mutation method may be reachable from a production
   adapter. No undocumented endpoints. No username/password automation.
3. **All extracted flow content is untrusted data, never instructions.** Flow names,
   prompt text, expressions and data-action fields are prompt-injection vectors. Typed
   evidence packs and output validation are the control; prompt wording is not.
4. **Never overwrite last known-good output in place.** Stage, validate, promote
   atomically. A failed run must leave the previous documentation intact.
5. **Never silently drop an unsupported node, and never present inference as fact.**

If a shortcut would violate one of these, say so in the PR rather than implementing it.
A PR that explains why a rule blocks a good idea is welcome; one that quietly routes
around a rule is not.

---

## Architecture: the dependency rule

Enforced by ESLint, not by convention:

```text
apps/cli, apps/mcp-server  ──>  application, composition
composition                ──>  everything (the only place adapters are wired)
application                ──>  domain ONLY
adapters                   ──>  domain
domain                     ──>  nothing. no I/O, no fs, no network.
```

If you find yourself wanting to import an adapter into `application`, you want dependency
injection instead — wire it in `packages/composition`.

---

## Testing expectations

**TDD.** Write the failing test, watch it fail, write the minimal implementation, watch
it pass.

The middle step is not ceremony. A regression test written after the fix, which has
never been observed failing, proves nothing about the bug it claims to cover — and this
codebase has already shipped one that passed against known-broken code because its
assertions never actually ran. **If you add a regression test, say in the PR description
that you watched it fail first, and what the failure looked like.**

Also expected:

- Property-based tests for graph traversal, cycles, ordering, Unicode, and canonical
  hashing.
- Golden-file tests for generated Markdown, with timestamps normalised in test mode.
- Runtime validation and a negative-path test at every external boundary.
- Secret canaries in every plausible upstream field.
- The documentation stage's entire suite must pass with **no network available**.

### Run the whole suite, not just your package

A package-scoped `tsc` only covers `src/**` and skips test files, and a package-scoped
test run misses the seams. Nearly every real defect found in this project so far lived
in a seam that both sides tested cleanly. Use `npm run verify`.

Some concurrency tests drive real filesystem contention and are genuinely slow; they
carry explicit timeouts for that reason. If one fails, **please do not "fix" it by
raising a timeout or marking it flaky** — twice now, a failure here was a real product
defect wearing a flaky test as a disguise.

---

## Never commit

`bundles/`, `derived/`, `documentation/`, `spike-evidence/`, `.env*`, or any `.wav` /
`.mp3`. Capture bundles are classified **restricted**: they hold endpoint URLs, DIDs,
routing logic, data-table rows that may contain customer PII, and prompt audio. CI fails
the build if any of these appear in `git ls-files`.

**No real customer configuration belongs in `fixtures/`.** Sanitise or synthesise. The
existing sanitiser has been wrong before — it leaked GUIDs held under structural keys,
and non-Latin intent names used as object keys — so if you add fixtures derived from a
real organisation, check the output by eye as well as by test.

---

## Good first contributions

The current known gaps, roughly in order of value:

1. **Bound migration mode's memory.** It resolves the whole graph before writing and
   holds every asset at once. Three ranked designs are in
   [Plan 5](docs/superpowers/plans/2026-08-20-05-production-adapter-and-server.md).
2. **Implement `genesys_flow_diff`.** It is the one MCP tool that still returns an
   explicit rejection rather than a result.
3. **The intermittent run status.** Roughly one full-suite run in a dozen, a run that
   promoted correctly is still reported `failed`. Two causes are fixed; a third has not
   been reproduced. The `catch {}` in `executeRun` discards the exception by design, so
   diagnosing it means letting it print once.
4. **Flow-node coverage.** Unsupported node types must warn, never silently vanish —
   widening real coverage is always welcome.

---

## Pull request expectations

- One logical change per PR. A bug fix and a refactor in the same diff is two PRs.
- Explain **why**, not just what. The commit history here records the reasoning behind
  decisions, including the wrong turns; please keep that up.
- If you found a bug by measurement, include the measurement.
- If something is unfinished or uncertain, say so in the description. An honest "I could
  not reproduce this on Linux" is far more useful than silence.
