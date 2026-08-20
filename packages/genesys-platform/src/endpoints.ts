// packages/genesys-platform/src/endpoints.ts
//
// Typed, zod-validated wrappers over the GET endpoints this adapter calls.
// Every path below was read out of the pinned `purecloud-platform-client-v2`
// SDK's source (AGENTS.md: read the SDK, do not import it), not guessed or
// taken from documentation prose, which is how S2 discovered a stale local
// enum silently under-counted flows by twenty.
//
// Schemas are deliberately loose (`.passthrough()` / a typed subset of
// fields) rather than exhaustive. The configuration endpoint response in
// particular is large, tenant-defined, and evolves with every Architect
// feature Genesys ships; rejecting a real response because this file did not
// anticipate one more optional field would be worse than accepting fields it
// does not otherwise use. What *is* validated is exactly what the rest of
// this repository reads out of each response.
import { z } from 'zod';
import type { PlatformApiClient } from './client.js';

const enc = (value: string): string => encodeURIComponent(value);

// ---------------------------------------------------------------------------
// organizations
// ---------------------------------------------------------------------------

export const organizationSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
  })
  .loose();
export type Organization = z.infer<typeof organizationSchema>;

export async function getOrganizationsMe(client: PlatformApiClient): Promise<Organization> {
  return client.get('/api/v2/organizations/me', { schema: organizationSchema });
}

// ---------------------------------------------------------------------------
// flows
// ---------------------------------------------------------------------------

const idRefSchema = z.object({ id: z.string() }).loose();

export const flowSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    division: idRefSchema.nullish(),
    publishedVersion: idRefSchema.nullish(),
  })
  .loose();
export type FlowSummary = z.infer<typeof flowSummarySchema>;

const pageSchema = <T extends z.ZodType>(entity: T) =>
  z
    .object({
      entities: z.array(entity).default([]),
      pageNumber: z.number().nullish(),
      pageSize: z.number().nullish(),
      pageCount: z.number().nullish(),
      total: z.number().nullish(),
    })
    .loose();

export const flowsPageSchema = pageSchema(flowSummarySchema);
export type FlowsPage = z.infer<typeof flowsPageSchema>;

export interface ListFlowsQuery {
  readonly type?: readonly string[];
  readonly divisionId?: readonly string[];
  readonly pageNumber: number;
  readonly pageSize: number;
}

export async function getFlows(
  client: PlatformApiClient,
  query: ListFlowsQuery,
): Promise<FlowsPage> {
  return client.get('/api/v2/flows', {
    query: {
      type: query.type,
      divisionId: query.divisionId,
      pageNumber: query.pageNumber,
      pageSize: query.pageSize,
    },
    schema: flowsPageSchema,
  });
}

export async function getFlow(client: PlatformApiClient, flowId: string): Promise<FlowSummary> {
  return client.get(`/api/v2/flows/${enc(flowId)}`, { schema: flowSummarySchema });
}

/**
 * The primary capture source (ADR-015, ADR-019). `manifest` is validated
 * generically -- a record of resource-type name to a list of references --
 * so a manifest key this adapter has never seen still parses instead of
 * failing the whole configuration fetch. `packages/genesys-source` is what
 * decides whether it knows how to *resolve* an unfamiliar type; this schema
 * only decides whether the envelope around it is well-formed.
 */
const manifestContextSchema = z
  .object({
    id: z.string().nullish(),
    actionName: z.string().nullish(),
    name: z.string().nullish(),
  })
  .loose();

const manifestEntrySchema = z
  .object({
    id: z.string().nullish(),
    name: z.string().nullish(),
    context: z.array(manifestContextSchema).nullish(),
  })
  .loose();

export const flowConfigurationSchema = z
  .object({
    name: z.string().nullish(),
    type: z.string().nullish(),
    nextTrackingNumber: z.number().nullish(),
    manifest: z.record(z.string(), z.array(manifestEntrySchema)).nullish(),
  })
  .loose();
export type FlowConfiguration = z.infer<typeof flowConfigurationSchema>;

export async function getFlowVersionConfiguration(
  client: PlatformApiClient,
  flowId: string,
  versionId: string,
): Promise<FlowConfiguration> {
  return client.get(`/api/v2/flows/${enc(flowId)}/versions/${enc(versionId)}/configuration`, {
    schema: flowConfigurationSchema,
  });
}

export async function getFlowLatestConfiguration(
  client: PlatformApiClient,
  flowId: string,
): Promise<FlowConfiguration> {
  return client.get(`/api/v2/flows/${enc(flowId)}/latestconfiguration`, {
    schema: flowConfigurationSchema,
  });
}

export const flowVersionSchema = z.object({ id: z.string() }).loose();
export const flowVersionsPageSchema = pageSchema(flowVersionSchema);
export type FlowVersionsPage = z.infer<typeof flowVersionsPageSchema>;

export async function getFlowVersions(
  client: PlatformApiClient,
  flowId: string,
  query: { readonly pageNumber: number; readonly pageSize: number },
): Promise<FlowVersionsPage> {
  return client.get(`/api/v2/flows/${enc(flowId)}/versions`, {
    query: { pageNumber: query.pageNumber, pageSize: query.pageSize },
    schema: flowVersionsPageSchema,
  });
}

// ---------------------------------------------------------------------------
// routing queues
// ---------------------------------------------------------------------------

export const routingQueueSchema = z.object({ id: z.string(), name: z.string() }).loose();
export type RoutingQueue = z.infer<typeof routingQueueSchema>;

export async function getRoutingQueue(
  client: PlatformApiClient,
  queueId: string,
): Promise<RoutingQueue> {
  return client.get(`/api/v2/routing/queues/${enc(queueId)}`, { schema: routingQueueSchema });
}

// ---------------------------------------------------------------------------
// user prompts and their audio resources
// ---------------------------------------------------------------------------

export const promptResourceSchema = z
  .object({
    language: z.string().nullish(),
    mediaUri: z.string().nullish(),
    fileName: z.string().nullish(),
  })
  .loose();
export type PromptResource = z.infer<typeof promptResourceSchema>;

export const userPromptSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullish(),
    resources: z.array(promptResourceSchema).nullish(),
  })
  .loose();
export type UserPrompt = z.infer<typeof userPromptSchema>;

export async function getUserPrompt(
  client: PlatformApiClient,
  promptId: string,
): Promise<UserPrompt> {
  return client.get(`/api/v2/architect/prompts/${enc(promptId)}`, { schema: userPromptSchema });
}

export const promptResourcesPageSchema = pageSchema(promptResourceSchema);
export type PromptResourcesPage = z.infer<typeof promptResourcesPageSchema>;

export async function getUserPromptResources(
  client: PlatformApiClient,
  promptId: string,
  query: { readonly pageNumber: number; readonly pageSize: number },
): Promise<PromptResourcesPage> {
  return client.get(`/api/v2/architect/prompts/${enc(promptId)}/resources`, {
    query: { pageNumber: query.pageNumber, pageSize: query.pageSize },
    schema: promptResourcesPageSchema,
  });
}

// ---------------------------------------------------------------------------
// system prompts
// ---------------------------------------------------------------------------

export const systemPromptSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    resources: z.array(promptResourceSchema).nullish(),
  })
  .loose();
export type SystemPrompt = z.infer<typeof systemPromptSchema>;

export async function getSystemPrompt(
  client: PlatformApiClient,
  promptId: string,
): Promise<SystemPrompt> {
  return client.get(`/api/v2/architect/systemprompts/${enc(promptId)}`, {
    schema: systemPromptSchema,
  });
}

// ---------------------------------------------------------------------------
// integrations and data actions
//
// S3 Finding 3: `getIntegration`'s response did not carry a `credentials`
// field at all under the OAuth client used in the spike -- the property
// holds structurally, not merely by discipline. This schema does not
// declare `credentials`, so even if a future response body carried one it
// would not be picked up by any typed field a caller reads; the redactor in
// `packages/genesys-source` still strips it defensively from the raw object
// before it can reach `safeMetadata`.
// ---------------------------------------------------------------------------

export const integrationSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    integrationType: z.object({ id: z.string().nullish() }).loose().nullish(),
  })
  .loose();
export type Integration = z.infer<typeof integrationSchema>;

/**
 * Strips a fixed set of known-sensitive key names from an already-validated,
 * passthrough-parsed object. `integrationSchema` uses `.loose()` so an
 * unrecognized field does not fail validation, but "unrecognized" and "safe
 * to keep" are different claims -- this closes that gap for the one field
 * name Genesys documents integration credentials living under, on top of
 * (not instead of) S3 Finding 3's structural observation that a real
 * response does not carry it at all.
 */
function omitCredentials<T extends Record<string, unknown>>(value: T): T {
  const clone: Record<string, unknown> = { ...value };
  delete clone['credentials'];
  return clone as T;
}

export async function getIntegration(
  client: PlatformApiClient,
  integrationId: string,
): Promise<Integration> {
  const raw = await client.get(`/api/v2/integrations/${enc(integrationId)}`, {
    schema: integrationSchema,
  });
  return omitCredentials(raw);
}

export const integrationActionSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    category: z.string().nullish(),
    integrationId: z.string().nullish(),
    secure: z.boolean().nullish(),
    contract: z.unknown().nullish(),
  })
  .loose();
export type IntegrationAction = z.infer<typeof integrationActionSchema>;

export async function getIntegrationAction(
  client: PlatformApiClient,
  actionId: string,
): Promise<IntegrationAction> {
  return client.get(`/api/v2/integrations/actions/${enc(actionId)}`, {
    schema: integrationActionSchema,
  });
}

// ---------------------------------------------------------------------------
// data tables and rows
// ---------------------------------------------------------------------------

export const dataTableSchema = z.object({ id: z.string(), name: z.string().nullish() }).loose();
export type DataTable = z.infer<typeof dataTableSchema>;

export async function getDataTable(client: PlatformApiClient, tableId: string): Promise<DataTable> {
  return client.get(`/api/v2/flows/datatables/${enc(tableId)}`, { schema: dataTableSchema });
}

const dataTableRowSchema = z.record(z.string(), z.unknown());
export const dataTableRowsPageSchema = pageSchema(dataTableRowSchema);
export type DataTableRowsPage = z.infer<typeof dataTableRowsPageSchema>;

export async function getDataTableRows(
  client: PlatformApiClient,
  tableId: string,
  query: { readonly pageNumber: number; readonly pageSize: number },
): Promise<DataTableRowsPage> {
  return client.get(`/api/v2/flows/datatables/${enc(tableId)}/rows`, {
    query: { pageNumber: query.pageNumber, pageSize: query.pageSize, showbrief: false },
    schema: dataTableRowsPageSchema,
  });
}

// ---------------------------------------------------------------------------
// schedules, schedule groups, emergency groups, IVRs
// ---------------------------------------------------------------------------

export const scheduleSchema = z.object({ id: z.string(), name: z.string().nullish() }).loose();
export async function getSchedule(
  client: PlatformApiClient,
  id: string,
): Promise<z.infer<typeof scheduleSchema>> {
  return client.get(`/api/v2/architect/schedules/${enc(id)}`, { schema: scheduleSchema });
}

export const scheduleGroupSchema = z.object({ id: z.string(), name: z.string().nullish() }).loose();
export async function getScheduleGroup(
  client: PlatformApiClient,
  id: string,
): Promise<z.infer<typeof scheduleGroupSchema>> {
  return client.get(`/api/v2/architect/schedulegroups/${enc(id)}`, { schema: scheduleGroupSchema });
}

export const emergencyGroupSchema = z
  .object({ id: z.string(), name: z.string().nullish() })
  .loose();
export async function getEmergencyGroup(
  client: PlatformApiClient,
  id: string,
): Promise<z.infer<typeof emergencyGroupSchema>> {
  return client.get(`/api/v2/architect/emergencygroups/${enc(id)}`, {
    schema: emergencyGroupSchema,
  });
}

export const ivrSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    dnis: z.array(z.string()).nullish(),
    openHoursFlow: idRefSchema.nullish(),
    closedHoursFlow: idRefSchema.nullish(),
    holidayHoursFlow: idRefSchema.nullish(),
  })
  .loose();
export type Ivr = z.infer<typeof ivrSchema>;

export async function getIvr(client: PlatformApiClient, id: string): Promise<Ivr> {
  return client.get(`/api/v2/architect/ivrs/${enc(id)}`, { schema: ivrSchema });
}

export const ivrsPageSchema = pageSchema(ivrSchema);
export async function getIvrs(
  client: PlatformApiClient,
  query: { readonly pageNumber: number; readonly pageSize: number },
): Promise<z.infer<typeof ivrsPageSchema>> {
  return client.get('/api/v2/architect/ivrs', {
    query: { pageNumber: query.pageNumber, pageSize: query.pageSize },
    schema: ivrsPageSchema,
  });
}

// ---------------------------------------------------------------------------
// languages
//
// TTS engines and voices have no read endpoint in the pinned SDK -- grepping
// its source for every Api.js file under api/ turns up no
// TextToSpeechApi.js and no method whose path contains "texttospeech" or
// "voices" at organization scope. `packages/genesys-source` therefore
// reports the manifest's `ttsEngine` and `ttsVoice` reference types as
// `unsupported` rather than guessing a path: AGENTS.md forbids calling an
// undocumented endpoint, and there is no documented one to call.
// ---------------------------------------------------------------------------

export const languageSchema = z.object({ id: z.string(), name: z.string().nullish() }).loose();
export async function getLanguage(
  client: PlatformApiClient,
  id: string,
): Promise<z.infer<typeof languageSchema>> {
  return client.get(`/api/v2/languages/${enc(id)}`, { schema: languageSchema });
}
