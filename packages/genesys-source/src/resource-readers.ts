// packages/genesys-source/src/resource-readers.ts
//
// One reader per manifest resource type this adapter knows how to resolve.
// `createResourceReaders` returns a lookup keyed by manifest type name; a
// type with no entry is handled by the caller (`platform-source-provider.ts`)
// as `unsupported` -- never silently skipped, per AGENTS.md.
import {
  asResourceId,
  type DependencyRef,
  type DependencyResolution,
  type DependencyResolutionStatus,
} from '@genesys-archivist/domain';
import {
  PlatformApiError,
  type PlatformApiClient,
  type PromptResource,
  getDataTable,
  getDataTableRows,
  getEmergencyGroup,
  getIntegration,
  getIntegrationAction,
  getIvr,
  getLanguage,
  getRoutingQueue,
  getSchedule,
  getScheduleGroup,
  getSystemPrompt,
  getUserPrompt,
} from '@genesys-archivist/genesys-platform';
import { redactResourceBody } from './redact-resource.js';

export type ResourceReader = (id: string) => Promise<DependencyResolution>;

interface FetchedResource {
  readonly displayName: string | null;
  /** Metadata only -- never an `assets` or `dataTableRows` payload. Those are
   * merged in unredacted after this returns, because `redactResourceBody`
   * walks plain objects and arrays: handed a `Uint8Array` of audio bytes, it
   * would read it as an array-like of numeric-string keys and rebuild it as
   * a plain object, silently destroying the very bytes `extractAssets` in
   * `capture-run.ts` requires to still be `instanceof Uint8Array`. */
  readonly metadata: Record<string, unknown>;
  readonly references?: readonly DependencyRef[];
  /** Plural because a prompt has one recording per language. See
   * `downloadAllAssets`. */
  readonly assets?: readonly {
    readonly bytes: Uint8Array;
    readonly originalName: string;
    readonly mimeType: string;
  }[];
  readonly dataTableRows?: readonly unknown[];
}

/**
 * A ref this adapter has no reader for could not be resolved as `not_found`
 * or `forbidden` -- both are claims about a *specific* resource this file
 * knows how to ask about. `unsupported` is the honest status: the type is
 * one this adapter has never learned to read, not one Genesys reports as
 * absent or off-limits.
 */
function unsupportedResolution(ref: DependencyRef): DependencyResolution {
  return { ref, status: 'unsupported', displayName: null, safeMetadata: {} };
}

/**
 * A transient failure (429 exhausted, 5xx exhausted, a network error, or a
 * response that failed schema validation) is not the same claim as
 * `not_found` (this resource does not exist) or `forbidden` (a permission is
 * missing) -- both of those would be more specific, and wrong, than what is
 * actually known. `partially_resolved` is the closest honest fit in the
 * domain's status enum: the reference is real (it came from a manifest a
 * flow actually carries) but this run could not read its body. The category
 * is recorded, not the raw error message, which could carry a header value
 * or an upstream detail this boundary must not persist.
 */
function classifyFailure(err: unknown): { status: DependencyResolutionStatus; issue: string } {
  if (err instanceof PlatformApiError) {
    if (err.status === 403) return { status: 'forbidden', issue: 'permission' };
    if (err.status === 404) return { status: 'not_found', issue: 'not_found' };
    return { status: 'partially_resolved', issue: err.category };
  }
  return { status: 'partially_resolved', issue: 'unknown' };
}

function toResolution(ref: DependencyRef, fetched: FetchedResource): DependencyResolution {
  const redactedMetadata = redactResourceBody(fetched.metadata) as Record<string, unknown>;
  const safeMetadata: Record<string, unknown> = { ...redactedMetadata };
  if (fetched.references !== undefined) safeMetadata['references'] = fetched.references;
  if (fetched.assets !== undefined) safeMetadata['assets'] = fetched.assets;
  if (fetched.dataTableRows !== undefined) safeMetadata['dataTableRows'] = fetched.dataTableRows;
  return { ref, status: 'resolved', displayName: fetched.displayName, safeMetadata };
}

function makeReader(type: string, fetch: (id: string) => Promise<FetchedResource>): ResourceReader {
  return async (id: string): Promise<DependencyResolution> => {
    const ref: DependencyRef = { type, id: asResourceId(id) };
    try {
      return toResolution(ref, await fetch(id));
    } catch (err) {
      const { status, issue } = classifyFailure(err);
      return {
        ref,
        status,
        displayName: null,
        safeMetadata: status === 'partially_resolved' ? { resolutionIssue: issue } : {},
      };
    }
  };
}

/** Bounds how many rows a single data table resolution will fetch. Data
 * tables are unbounded tenant content; without a cap, one very large table
 * could dominate a run's memory and request budget. This is a pragmatic
 * engineering bound, not a measured one -- unlike the pagination and retry
 * bounds elsewhere in this package, no spike measured a real table's size. */
const MAX_DATA_TABLE_ROWS = 2_000;
const DATA_TABLE_PAGE_SIZE = 100;

async function fetchDataTableRows(client: PlatformApiClient, tableId: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  let pageNumber = 1;
  for (;;) {
    const page = await getDataTableRows(client, tableId, {
      pageNumber,
      pageSize: DATA_TABLE_PAGE_SIZE,
    });
    rows.push(...page.entities);
    if (rows.length >= MAX_DATA_TABLE_ROWS) return rows.slice(0, MAX_DATA_TABLE_ROWS);
    if (page.entities.length < DATA_TABLE_PAGE_SIZE) return rows;
    if (typeof page.pageCount === 'number' && pageNumber >= page.pageCount) return rows;
    pageNumber += 1;
  }
}

/**
 * Genesys serves prompt audio from a signed, time-limited media URI (S5:
 * ~3,580-3,584 seconds). `PlatformApiClient` classifies a 403 from that host
 * as `expired_asset_url`, distinct from `permission` -- this is where that
 * distinction gets acted on: exactly one retry, and only by re-resolving the
 * owning prompt for a *fresh* URI, never by retrying the same expired one.
 * `refetchResources` therefore re-calls the prompt endpoint; nothing here
 * ever stores a URI anywhere that outlives this single download attempt.
 */
async function downloadWithExpiryRetry(
  client: PlatformApiClient,
  initialUri: string,
  refetchUri: () => Promise<string | null>,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  try {
    const bin = await client.getBinary(initialUri);
    return { bytes: bin.bytes, mimeType: bin.contentType };
  } catch (err) {
    if (err instanceof PlatformApiError && err.category === 'expired_asset_url') {
      const freshUri = await refetchUri();
      if (freshUri !== null) {
        const bin = await client.getBinary(freshUri);
        return { bytes: bin.bytes, mimeType: bin.contentType };
      }
    }
    throw err;
  }
}

interface DownloadedAsset {
  readonly bytes: Uint8Array;
  readonly originalName: string;
  readonly mimeType: string;
}

/**
 * Downloads **every** language of a prompt, not the first one that works.
 *
 * A Genesys prompt carries one recording per language, and this adapter
 * originally returned only the first because `safeMetadata` had a single
 * `asset` slot. That made a `migration` bundle for a bilingual IVR capture the
 * English audio, drop the Arabic, and still seal itself migration-ready --
 * exactly the silent incompleteness AGENTS.md forbids, and invisible in a
 * monolingual sandbox. `capture-run.ts` now reads a plural `assets` array.
 *
 * A language whose download fails is skipped rather than failing the whole
 * prompt, and every language present is still named in `availableLanguages`,
 * so a reader can compare what exists against what was captured. Returning
 * partial audio is acceptable; returning partial audio *silently* is not.
 */
async function downloadAllAssets(
  client: PlatformApiClient,
  resources: readonly PromptResource[],
  refetchResources: () => Promise<readonly PromptResource[]>,
): Promise<readonly DownloadedAsset[]> {
  const assets: DownloadedAsset[] = [];
  for (const resource of resources) {
    if (
      resource.mediaUri === null ||
      resource.mediaUri === undefined ||
      resource.mediaUri.length === 0
    ) {
      continue;
    }
    const language = resource.language ?? 'unknown';
    try {
      const { bytes, mimeType } = await downloadWithExpiryRetry(
        client,
        resource.mediaUri,
        async () => {
          const fresh = await refetchResources();
          return fresh.find((r) => r.language === resource.language)?.mediaUri ?? null;
        },
      );
      assets.push({
        bytes,
        // The language is part of the name because the asset store is
        // content-addressed: two languages of the same prompt are two
        // different files, and `index.json` is the only place a human can
        // tell which is which.
        originalName: resource.fileName ?? `${language}.wav`,
        mimeType,
      });
    } catch {
      continue;
    }
  }
  return assets;
}

export function createResourceReaders(
  client: PlatformApiClient,
): ReadonlyMap<string, ResourceReader> {
  const readers = new Map<string, ResourceReader>();

  readers.set(
    'queue',
    makeReader('queue', async (id) => {
      const queue = await getRoutingQueue(client, id);
      return { displayName: queue.name, metadata: queue };
    }),
  );

  readers.set(
    'dataAction',
    makeReader('dataAction', async (id) => {
      const action = await getIntegrationAction(client, id);
      const references: DependencyRef[] =
        action.integrationId !== null && action.integrationId !== undefined
          ? [{ type: 'integration', id: asResourceId(action.integrationId) }]
          : [];
      return { displayName: action.name ?? null, metadata: action, references };
    }),
  );

  readers.set(
    'integration',
    makeReader('integration', async (id) => {
      // getIntegration already strips a `credentials` field at the endpoint
      // layer (S3 Finding 3 + defence in depth); redactResourceBody is a
      // second, independent pass over whatever is left.
      const integration = await getIntegration(client, id);
      return { displayName: integration.name ?? null, metadata: integration };
    }),
  );

  readers.set(
    'userPrompt',
    makeReader('userPrompt', async (id) => {
      const prompt = await getUserPrompt(client, id);
      const resources = prompt.resources ?? [];
      const assets = await downloadAllAssets(client, resources, async () => {
        const fresh = await getUserPrompt(client, id);
        return fresh.resources ?? [];
      });
      return {
        displayName: prompt.name,
        metadata: {
          name: prompt.name,
          description: prompt.description ?? null,
          availableLanguages: resources
            .map((r) => r.language)
            .filter((l): l is string => l !== null && l !== undefined),
          capturedAssetCount: assets.length,
        },
        ...(assets.length > 0 ? { assets } : {}),
      };
    }),
  );

  readers.set(
    'systemPrompt',
    makeReader('systemPrompt', async (id) => {
      const prompt = await getSystemPrompt(client, id);
      const resources = prompt.resources ?? [];
      const assets = await downloadAllAssets(client, resources, async () => {
        const fresh = await getSystemPrompt(client, id);
        return fresh.resources ?? [];
      });
      return {
        displayName: prompt.name ?? null,
        metadata: {
          name: prompt.name ?? null,
          description: prompt.description ?? null,
          availableLanguages: resources
            .map((r) => r.language)
            .filter((l): l is string => l !== null && l !== undefined),
          capturedAssetCount: assets.length,
        },
        ...(assets.length > 0 ? { assets } : {}),
      };
    }),
  );

  readers.set(
    'language',
    makeReader('language', async (id) => {
      const language = await getLanguage(client, id);
      return { displayName: language.name ?? null, metadata: language };
    }),
  );

  readers.set(
    'dataTable',
    makeReader('dataTable', async (id) => {
      const table = await getDataTable(client, id);
      const rows = await fetchDataTableRows(client, id);
      return {
        displayName: table.name ?? null,
        metadata: { name: table.name ?? null },
        ...(rows.length > 0 ? { dataTableRows: rows } : {}),
      };
    }),
  );

  readers.set(
    'schedule',
    makeReader('schedule', async (id) => {
      const schedule = await getSchedule(client, id);
      return { displayName: schedule.name ?? null, metadata: schedule };
    }),
  );

  readers.set(
    'scheduleGroup',
    makeReader('scheduleGroup', async (id) => {
      const group = await getScheduleGroup(client, id);
      return { displayName: group.name ?? null, metadata: group };
    }),
  );

  readers.set(
    'emergencyGroup',
    makeReader('emergencyGroup', async (id) => {
      const group = await getEmergencyGroup(client, id);
      return { displayName: group.name ?? null, metadata: group };
    }),
  );

  readers.set(
    'ivr',
    makeReader('ivr', async (id) => {
      const ivr = await getIvr(client, id);
      const references: DependencyRef[] = [];
      for (const ivrFlow of [ivr.openHoursFlow, ivr.closedHoursFlow, ivr.holidayHoursFlow]) {
        if (ivrFlow?.id !== undefined)
          references.push({ type: 'flow', id: asResourceId(ivrFlow.id) });
      }
      return { displayName: ivr.name ?? null, metadata: ivr, references };
    }),
  );

  // ttsEngine and ttsVoice are deliberately absent: docs/spikes/S3-references.md
  // lists them among the manifest's resource types, but the pinned SDK has
  // no TextToSpeechApi and no endpoint whose path mentions "texttospeech" or
  // "voices" (grepped, see endpoints.ts's comment on `getLanguage`). Absence
  // of a reader here is what makes the dispatcher report them `unsupported`
  // rather than silently skip them.
  //
  // `user` is also deliberately absent, for a different reason: a user
  // record is personal data, and this adapter has no endpoint wrapper that
  // fetches one (none was in scope for this task). Leaving it unread means
  // a `user` reference resolves to `unsupported` with empty `safeMetadata`
  // -- disclosed, never silently dropped -- and, just as importantly,
  // structurally carries no name, email, or extension, because nothing here
  // ever asks Genesys for them. If a future task adds a reader for `user`,
  // it must keep that same restriction deliberately, not by accident of
  // scope.
  //
  // The wider corpus in `fixtures/flow-config/` additionally surfaces
  // `botFlow`, `composerScript`, `contactList`, `flowOutcome`, `grammar`,
  // `image`, `knowledgeBase`, `nluDomain`, `sttEngine`, `surveyForm`,
  // `acdLanguage`, and `acdWrapupCode` -- twelve more manifest types this
  // adapter has no reader for. Every one of them falls through to
  // `unsupported` the same way, which is exactly why `manifest.ts` iterates
  // manifest keys generically instead of enumerating the ones this file
  // happens to have a reader for: the list of unread types will keep
  // growing as the flow-type corpus widens, and none of them may vanish
  // from the resource graph silently when it does.

  return readers;
}

export { unsupportedResolution };
