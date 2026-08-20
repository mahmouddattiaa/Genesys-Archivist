#!/usr/bin/env node
/**
 * Phase 0 spike — prompt audio download.
 *
 * Question: can prompt audio be downloaded with read-only permissions?
 *
 * This is kill criterion 11 in docs/spikes/README.md. If it fails, the capture
 * bundle is documentation-grade rather than migration-grade, and ADR-018's
 * `migration` mode must say so plainly in the manifest instead of implying a
 * migration path that does not exist. That makes this a product decision, not
 * an implementation detail: `migration` mode is one of the two things the
 * product offers.
 *
 * (Numbering: docs/spikes/README.md calls this S4 and docs/14 does not have it
 * at all. See the numbering warning in docs/spikes/README.md. Filed as s5 here
 * because docs/spikes/S4-permission-matrix.md already exists under the name the
 * rest of the repository uses.)
 *
 * What it measures:
 *   1. Are prompt resources listable read-only?
 *   2. Does each resource carry a downloadable media URI?
 *   3. Does the media URI download WITHOUT the bearer token — i.e. is it a
 *      pre-signed URL — and does it hash stably?
 *   4. How long does a signed URL stay valid? (bounded probe, not a full wait)
 *   5. What is the total asset byte count for the sandbox organization?
 *
 * Throwaway code. Not production architecture. Do not import it from packages/.
 *
 * NEVER prints the client secret, a signed URL, or audio bytes. A signed URL is
 * a bearer credential for the object it points at, and prompt audio is customer
 * configuration. Evidence stores hashes and byte counts only.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT, attempt, authenticate, loadSpikeEnv, platformClient } from './env.mjs';

const hash = (s) => 'n_' + createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);

/** Cap the probe so a large sandbox does not turn this into a full capture. */
const MAX_PROMPTS = 25;
const MAX_DOWNLOADS = 10;

async function pageThrough(call, { pageSize = 100, maxPages = 20 } = {}) {
  const entities = [];
  let pageNumber = 1;
  for (;;) {
    const res = await attempt('page', () => call({ pageSize, pageNumber }));
    if (!res.ok) return { entities, status: res.status, complete: false };
    const batch = res.body?.entities ?? [];
    entities.push(...batch);
    const pageCount = res.body?.pageCount;
    if (batch.length === 0) break;
    if (typeof pageCount === 'number' && pageNumber >= pageCount) break;
    if (pageNumber >= maxPages) return { entities, status: 200, complete: false };
    pageNumber += 1;
  }
  return { entities, status: 200, complete: true };
}

/**
 * Downloads a media URI with plain fetch and no Authorization header.
 *
 * Deliberately unauthenticated: the point of the probe is to learn whether the
 * URI is pre-signed. If it needs the bearer token, the adapter's asset
 * downloader has to carry credentials to a host it did not choose, which is a
 * materially different security story and belongs in the record.
 */
async function downloadUnauthenticated(uri) {
  try {
    const res = await fetch(uri, { redirect: 'follow' });
    if (!res.ok) return { ok: false, status: res.status, bytes: 0, digest: null, mime: null };
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      status: res.status,
      bytes: buf.byteLength,
      digest: 'sha256:' + createHash('sha256').update(buf).digest('hex'),
      mime: res.headers.get('content-type'),
    };
  } catch (err) {
    // Only the error name. A fetch failure message can contain the full URL,
    // and the URL is a bearer credential.
    return {
      ok: false,
      status: 0,
      bytes: 0,
      digest: null,
      mime: null,
      error: err?.name ?? 'Error',
    };
  }
}

/** Reads the `expires`/`X-Amz-Expires` hint out of a signed URL without logging it. */
function signedUrlLifetimeSeconds(uri) {
  try {
    const params = new URL(uri).searchParams;
    const amz = params.get('X-Amz-Expires');
    if (amz !== null) return Number(amz);
    const expires = params.get('Expires');
    if (expires !== null) return Number(expires) - Math.floor(Date.now() / 1000);
    return null;
  } catch {
    return null;
  }
}

async function collectResources(api, prompts, kind) {
  const rows = [];
  for (const prompt of prompts.slice(0, MAX_PROMPTS)) {
    // The list response usually inlines `resources`; fall back to the dedicated
    // endpoint so a thin list shape does not read as "no audio exists".
    let resources = prompt.resources ?? null;
    if (resources === null) {
      const method =
        kind === 'user' ? 'getArchitectPromptResources' : 'getArchitectSystempromptResources';
      const res = await attempt('resources', () => api[method](prompt.id, { pageSize: 100 }));
      resources = res.ok ? (res.body?.entities ?? []) : [];
    }
    for (const r of resources) {
      rows.push({
        promptId: hash(prompt.id),
        kind,
        language: r.language ?? null,
        hasMediaUri: typeof r.mediaUri === 'string' && r.mediaUri.length > 0,
        mediaUri: r.mediaUri ?? null,
        uploadStatus: r.uploadStatus ?? null,
        durationSeconds: r.durationSeconds ?? null,
      });
    }
  }
  return rows;
}

async function main() {
  const env = await loadSpikeEnv();
  console.log(`\nPrompt audio download   region=${env.region}\n`);
  await authenticate(env);
  ok('authenticated (client credentials grant)');

  const api = new platformClient.ArchitectApi();

  console.log('\nListing prompts');
  const user = await pageThrough((p) => api.getArchitectPrompts(p));
  const system = await pageThrough((p) => api.getArchitectSystemprompts(p));
  if (user.status === 403) bad('getArchitectPrompts — 403, architect:userPrompt:view missing');
  else ok(`${user.entities.length} user prompts (complete=${user.complete})`);
  if (system.status === 403)
    bad('getArchitectSystemprompts — 403, architect:systemPrompt:view missing');
  else ok(`${system.entities.length} system prompts (complete=${system.complete})`);

  console.log('\nResolving resources');
  const rows = [
    ...(await collectResources(api, user.entities, 'user')),
    ...(await collectResources(api, system.entities, 'system')),
  ];
  const withUri = rows.filter((r) => r.hasMediaUri);
  ok(`${rows.length} resources, ${withUri.length} carry a media URI`);
  if (rows.length > 0 && withUri.length === 0) {
    warn('resources exist but none expose a media URI — audio may require a different grant');
  }

  console.log('\nDownloading (unauthenticated, to test for pre-signed URLs)');
  const downloads = [];
  let totalBytes = 0;
  for (const r of withUri.slice(0, MAX_DOWNLOADS)) {
    const lifetime = signedUrlLifetimeSeconds(r.mediaUri);
    const first = await downloadUnauthenticated(r.mediaUri);
    // A second download of the same URI proves the bytes are stable, which is
    // what content-addressed bundle storage depends on.
    const second = first.ok ? await downloadUnauthenticated(r.mediaUri) : null;
    const stable = second !== null && second.digest === first.digest;

    downloads.push({
      promptId: r.promptId,
      kind: r.kind,
      language: r.language,
      ok: first.ok,
      status: first.status,
      bytes: first.bytes,
      mime: first.mime,
      digest: first.digest,
      stableAcrossReads: stable,
      signedUrlLifetimeSeconds: lifetime,
      preSigned: first.ok,
    });
    if (first.ok) {
      totalBytes += first.bytes;
      ok(
        `${r.kind}/${r.language ?? '—'} — ${first.bytes} bytes, ${first.mime ?? 'unknown type'}${stable ? ', stable' : ', UNSTABLE'}`,
      );
    } else {
      bad(`${r.kind}/${r.language ?? '—'} — status ${first.status}`);
    }
  }

  const succeeded = downloads.filter((d) => d.ok).length;
  const unstable = downloads.filter((d) => d.ok && !d.stableAcrossReads).length;
  const lifetimes = downloads
    .map((d) => d.signedUrlLifetimeSeconds)
    .filter((n) => typeof n === 'number' && Number.isFinite(n));

  /**
   * Three outcomes. INCONCLUSIVE is not a soft PASS: it means the sandbox had
   * nothing to measure, and a migration bundle built on that basis would be
   * claiming a capability nobody has demonstrated.
   */
  const gate =
    downloads.length === 0
      ? 'INCONCLUSIVE'
      : succeeded === downloads.length && unstable === 0
        ? 'PASS'
        : 'FAIL';

  console.log('\n' + '─'.repeat(64));
  console.log(`  gate:        ${gate}`);
  console.log(`  attempted:   ${downloads.length} of ${withUri.length} resources with a URI`);
  console.log(`  downloaded:  ${succeeded}`);
  console.log(`  unstable:    ${unstable}`);
  console.log(`  bytes:       ${totalBytes} across ${succeeded} files`);
  if (lifetimes.length > 0) {
    console.log(`  signed-url lifetime: ${Math.min(...lifetimes)}–${Math.max(...lifetimes)}s`);
  } else {
    console.log('  signed-url lifetime: not advertised in the URL');
  }
  if (gate === 'INCONCLUSIVE') {
    console.log('  nothing to measure: the sandbox exposes no downloadable prompt audio.');
    console.log('  migration mode must not claim asset completeness on this evidence.');
  }
  console.log('─'.repeat(64) + '\n');

  const dir = join(REPO_ROOT, 'spike-evidence');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 's5-assets.json'),
    JSON.stringify(
      {
        spike: 'prompt-audio-download',
        gate,
        region: env.region,
        userPrompts: user.entities.length,
        systemPrompts: system.entities.length,
        resources: rows.length,
        resourcesWithMediaUri: withUri.length,
        totalBytes,
        // mediaUri is deliberately omitted: a signed URL is a bearer credential.
        downloads,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log('evidence → spike-evidence/s5-assets.json\n');

  process.exitCode = gate === 'PASS' ? 0 : 1;
}

main().catch((err) => {
  console.error(`\nPrompt-audio spike failed: ${err?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
});
