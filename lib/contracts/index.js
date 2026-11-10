// The single source of truth for the AgentXRay HTTP contract layer.
//
// `definitions` is the ordered registry consumed by scripts/gen-api-types.mjs
// (order is part of the generated file's determinism). `routes` wires a route
// name to its request-query schema and success-response schema; the route
// modules use `validateQuery()` (throws → caller returns 400) and
// `validateResponse()` (dev/test only, never throws).
//
// Response validation is OFF by default so the hot path pays nothing; set
// AXR_CONTRACT=1 to validate every response and log drift as a warning. It can
// never change a status code or a response body.

const sessions = require('./sessions');
const context = require('./context');
const schema = require('./schema');

const { ContractError } = schema;

const definitions = [
  // shared
  sessions.TopTool,
  sessions.CountMap,
  sessions.MessageContentPart,
  sessions.MessageUsage,
  sessions.ContextUsage,
  // sessions
  sessions.SessionSummary,
  sessions.ListPage,
  sessions.SessionsPage,
  sessions.SessionMessage,
  sessions.SessionMeta,
  sessions.SessionStats,
  sessions.SessionMessagePage,
  sessions.SessionDetail,
  sessions.SessionFull,
  sessions.SessionMessagesPage,
  sessions.SessionTaskRecord,
  sessions.SessionTaskAnalysis,
  sessions.ChildAgentSummary,
  sessions.OpenSessionResult,
  sessions.ErrorResponse,
  sessions.SessionsListQuery,
  sessions.SessionDetailQuery,
  sessions.SessionFullQuery,
  sessions.SessionMessagesQuery,
  sessions.SessionTasksQuery,
  sessions.SessionChildrenQuery,
  sessions.SessionOpenQuery,
  // context
  context.ContextPromptComponent,
  context.ContextSystemPrompt,
  context.ContextHistorySummary,
  context.ContextHistory,
  context.ContextTools,
  context.ContextMetadata,
  context.ContextSnapshot,
  context.ContextError,
  context.ContextBatch,
  context.ContextQuery,
  context.ContextMessageIds,
];

const schemas = {};
for (const definition of definitions) {
  if (!definition.defName) throw new Error('contract definition without a name');
  if (schemas[definition.defName]) throw new Error(`duplicate contract definition: ${definition.defName}`);
  schemas[definition.defName] = definition;
}

const routes = {
  'sessions.list': { query: sessions.SessionsListQuery, response: sessions.SessionsPage },
  'sessions.detail': { query: sessions.SessionDetailQuery, response: sessions.SessionDetail },
  'sessions.full': { query: sessions.SessionFullQuery, response: sessions.SessionFull },
  'sessions.messages': { query: sessions.SessionMessagesQuery, response: sessions.SessionMessagesPage },
  'sessions.tasks': { query: sessions.SessionTasksQuery, response: sessions.SessionTaskAnalysis },
  'sessions.children': { query: sessions.SessionChildrenQuery, response: schema.array(sessions.ChildAgentSummary) },
  'sessions.open': { query: sessions.SessionOpenQuery, response: sessions.OpenSessionResult },
  'context.query': { query: context.ContextQuery },
  'context.single': { query: context.ContextQuery, response: context.ContextSnapshot },
  'context.batch': { query: context.ContextQuery, response: context.ContextBatch },
};

const RESPONSE_CHECK = process.env.AXR_CONTRACT === '1' || process.env.AXR_CONTRACT === 'true';

/**
 * Validate (and normalize) route query params.
 * @throws {ContractError} message embeds the offending parameter path.
 */
function validateQuery(routeName, query) {
  const route = routes[routeName];
  if (!route?.query) throw new Error(`unknown contract route: ${routeName}`);
  return route.query.parse(query || {});
}

/** Validate a batch of comma-separated context message ids (each element). */
function validateContextMessageIds(ids) {
  // Root the path at the HTTP parameter so a 400 tells the caller which param.
  return schemas.ContextMessageIds.parse(ids, '$.messageIds');
}

/**
 * Development/test-only response validation. Never throws, never mutates the
 * response: drift is logged so `AXR_CONTRACT=1` runs surface it.
 */
function validateResponse(routeName, body) {
  if (!RESPONSE_CHECK) return body;
  const route = routes[routeName];
  if (!route?.response) return body;
  try {
    route.response.parse(body);
  } catch (error) {
    console.warn(`[contract] ${routeName} response drift: ${error.message}`);
  }
  return body;
}

module.exports = {
  ContractError,
  definitions,
  routes,
  schemas,
  validateQuery,
  validateContextMessageIds,
  validateResponse,
  responseValidationEnabled: RESPONSE_CHECK,
};
