const DEFAULT_PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 200;
const DEFAULT_LIST_PAGE_SIZE = 100;

class PaginationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaginationError';
    this.statusCode = 400;
  }
}

function hasPaginationQuery(query = {}) {
  return query.limit !== undefined || query.before !== undefined;
}

/**
 * Parse the public `limit` / `before` query values shared by every paged
 * session route. Both are non-negative integers. `limit=0` is the historical
 * "no limit" sentinel; positive limits are capped at MAX_PAGE_SIZE. Missing
 * values have route-specific defaults. Malformed, repeated, negative, or
 * fractional values become HTTP 400 responses through PaginationError.
 */
function parseCursor(value, name) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (Array.isArray(value) || typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new PaginationError(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

function parsePageOptions(query = {}, { defaultLimit = DEFAULT_PAGE_SIZE, maxLimit = MAX_PAGE_SIZE } = {}) {
  const rawLimit = query.limit === undefined ? defaultLimit : parseCursor(query.limit, 'limit');
  const rawBefore = query.before === undefined ? null : parseCursor(query.before, 'before');
  const limit = rawLimit === 0 ? null : Math.min(rawLimit, maxLimit);
  return { limit, before: rawBefore };
}

function pageWindow(total, query, options) {
  const { limit: requestedLimit, before } = parsePageOptions(query, options);
  const end = Math.min(before ?? total, total);
  const effectiveLimit = requestedLimit === null ? total : requestedLimit;
  const start = Math.max(0, end - effectiveLimit);
  return {
    start,
    end,
    limit: effectiveLimit,
  };
}

function pageMetadata(total, { start, end, limit }) {
  return {
    total,
    limit,
    start,
    end,
    hasMoreBefore: start > 0,
    nextBefore: start > 0 ? String(start) : null,
  };
}

/**
 * Return one chronological message window from a complete message array.
 * `before` is an exclusive zero-based index into that array. The default window
 * is the newest DEFAULT_PAGE_SIZE records unless a caller supplies a limit.
 * Invalid query syntax throws; numeric cursors past the end clamp to the latest
 * window so a stale cursor cannot expose records outside the source array.
 */
function paginateMessages(messages, query = {}, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const window = pageWindow(list.length, query, options);
  return {
    messages: list.slice(window.start, window.end),
    page: pageMetadata(list.length, window),
  };
}

/**
 * Page a newest-first session list with the same cursor semantics as messages.
 * The returned slice keeps the adapter's existing newest-first order.
 */
function paginateList(items, query = {}, { defaultLimit = DEFAULT_LIST_PAGE_SIZE, maxLimit = MAX_PAGE_SIZE } = {}) {
  const list = Array.isArray(items) ? items : [];
  const window = pageWindow(list.length, query, { defaultLimit, maxLimit });
  return {
    items: list.slice(window.start, window.end),
    page: pageMetadata(list.length, window),
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_LIST_PAGE_SIZE,
  hasPaginationQuery,
  PaginationError,
  parsePageOptions,
  paginateMessages,
  paginateList,
};
