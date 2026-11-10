const DEFAULT_PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 200;
// The sidebar pages in larger chunks than the transcript: one page should cover
// what fits on screen several times over, while staying far below the old
// "everything at once" payload.
const DEFAULT_LIST_PAGE_SIZE = 100;

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function pageOptions(query = {}, { defaultLimit = null } = {}) {
  const rawLimit = query.limit === undefined ? defaultLimit : positiveInteger(query.limit);
  const limit = rawLimit === null || rawLimit === 0 ? null : Math.min(rawLimit, MAX_PAGE_SIZE);
  const before = query.before === undefined ? null : positiveInteger(query.before);
  return { limit, before };
}

function paginateMessages(messages, query = {}, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const { limit: requestedLimit, before } = pageOptions(query, options);
  if (requestedLimit === null) {
    return {
      messages: list,
      page: {
        total: list.length,
        limit: list.length,
        start: 0,
        end: list.length,
        loadedCount: list.length,
        hasMoreBefore: false,
        nextBefore: null,
      },
    };
  }

  const end = Math.min(before ?? list.length, list.length);
  const start = Math.max(0, end - requestedLimit);
  return {
    messages: list.slice(start, end),
    page: {
      total: list.length,
      limit: requestedLimit,
      start,
      end,
      loadedCount: end - start,
      hasMoreBefore: start > 0,
      nextBefore: start > 0 ? String(start) : null,
    },
  };
}

/**
 * Page a session LIST (the sidebar), newest-first.
 *
 * Why this exists: `/api/:platform/sessions` used to return every session with
 * every field (doubao: 128 sessions / 241 KB). At a few hundred sessions that is
 * a visible cost at boot, because `usePlatformProbe` calls it for all platforms
 * just to draw the tab counts. Lists now page like messages do, with the same
 * `limit`/`before` cursor semantics so callers only learn one convention.
 *
 * `before` is an index cursor into the newest-first list, matching paginateMessages.
 */
function paginateList(items, query = {}, { defaultLimit = DEFAULT_LIST_PAGE_SIZE, maxLimit = MAX_PAGE_SIZE } = {}) {
  const list = Array.isArray(items) ? items : [];
  const rawLimit = query.limit === undefined ? defaultLimit : positiveInteger(query.limit);
  const limit = rawLimit === null || rawLimit === 0 ? list.length : Math.min(rawLimit, maxLimit);
  const before = query.before === undefined ? list.length : (positiveInteger(query.before) ?? list.length);
  const end = Math.min(Math.max(before, 0), list.length);
  const start = Math.max(0, end - limit);
  return {
    items: list.slice(start, end),
    page: {
      total: list.length,
      limit,
      start,
      end,
      hasMore: start > 0,
      nextBefore: start > 0 ? String(start) : null,
    },
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_LIST_PAGE_SIZE,
  pageOptions,
  paginateMessages,
  paginateList,
};
