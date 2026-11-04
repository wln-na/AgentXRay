// GENERATED FILE — do not edit.
// Source of truth: frontend/src/lib/pure.ts + frontend/src/lib/markdown.ts.
// Regenerate with `node scripts/build-legacy-pure.mjs` (also runs in build:ui).
// Browser: functions land on window.* (loaded before the legacy app script).
// Node: require('public/js/pure.js') returns the same functions.
var __axrPure = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // frontend/src/lib/legacy-pure.ts
  var legacy_pure_exports = {};
  __export(legacy_pure_exports, {
    buildTraceTurns: () => buildTraceTurns,
    clusterPrefillContent: () => clusterPrefillContent,
    commonVersionLines: () => commonVersionLines,
    condenseContextDiff: () => condenseContextDiff,
    contextTextSignature: () => contextTextSignature,
    detectPatch: () => detectPatch,
    diffContextLines: () => diffContextLines,
    diffLineSegments: () => diffLineSegments,
    escapeHtml: () => escapeHtml,
    extractEmbeddedPatch: () => extractEmbeddedPatch,
    firstInformativeLine: () => firstInformativeLine,
    flattenSpans: () => flattenSpans,
    foldContextVersions: () => foldContextVersions,
    formatBytes: () => formatBytes,
    formatCost: () => formatCost,
    formatDurationCompact: () => formatDurationCompact,
    getTextContent: () => getTextContent,
    normalizeContextText: () => normalizeContextText,
    parseTimestampMs: () => parseTimestampMs,
    parseToolArguments: () => parseToolArguments,
    pickAutoPlatform: () => pickAutoPlatform,
    renderMarkdown: () => renderMarkdown,
    renderMarkdownHtml: () => renderMarkdownHtml
  });

  // frontend/src/lib/contextVersions.ts
  var MAX_DIFF_LINES = 400;
  var MAX_DIFF_CELLS = 25e4;
  function normalizeContextText(text) {
    return String(text ?? "").replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n").trim();
  }
  function splitLines(text) {
    if (!text) return [];
    return text.split("\n");
  }
  function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16);
  }
  function contextTextSignature(text) {
    return `${text.length}:${hashText(text)}`;
  }
  function coarseDiff(prevLines, nextLines) {
    const out = [];
    for (const text of prevLines) out.push({ type: "del", text });
    for (const text of nextLines) out.push({ type: "add", text });
    return out;
  }
  function diffContextLines(prevText, nextText) {
    const prev = splitLines(prevText);
    const next = splitLines(nextText);
    if (prev.length > MAX_DIFF_LINES || next.length > MAX_DIFF_LINES) return coarseDiff(prev, next);
    let start = 0;
    while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
    let endPrev = prev.length - 1;
    let endNext = next.length - 1;
    while (endPrev >= start && endNext >= start && prev[endPrev] === next[endNext]) {
      endPrev--;
      endNext--;
    }
    const midPrev = prev.slice(start, endPrev + 1);
    const midNext = next.slice(start, endNext + 1);
    const out = prev.slice(0, start).map((text) => ({ type: "same", text }));
    if (midPrev.length === 0 || midNext.length === 0 || midPrev.length * midNext.length > MAX_DIFF_CELLS) {
      out.push(...coarseDiff(midPrev, midNext));
    } else {
      const rows = midPrev.length + 1;
      const cols = midNext.length + 1;
      const lcs = [];
      for (let i2 = 0; i2 < rows; i2++) lcs.push(new Uint16Array(cols));
      for (let i2 = midPrev.length - 1; i2 >= 0; i2--) {
        for (let j2 = midNext.length - 1; j2 >= 0; j2--) {
          lcs[i2][j2] = midPrev[i2] === midNext[j2] ? lcs[i2 + 1][j2 + 1] + 1 : Math.max(lcs[i2 + 1][j2], lcs[i2][j2 + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < midPrev.length && j < midNext.length) {
        if (midPrev[i] === midNext[j]) {
          out.push({ type: "same", text: midPrev[i] });
          i++;
          j++;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
          out.push({ type: "del", text: midPrev[i] });
          i++;
        } else {
          out.push({ type: "add", text: midNext[j] });
          j++;
        }
      }
      while (i < midPrev.length) out.push({ type: "del", text: midPrev[i++] });
      while (j < midNext.length) out.push({ type: "add", text: midNext[j++] });
    }
    out.push(...prev.slice(endPrev + 1).map((text) => ({ type: "same", text })));
    return out;
  }
  function condenseContextDiff(diff, context = 2) {
    const keep = /* @__PURE__ */ new Set();
    diff.forEach((line, i2) => {
      if (line.type === "same") return;
      for (let offset = -context; offset <= context; offset++) {
        const target = i2 + offset;
        if (target >= 0 && target < diff.length) keep.add(target);
      }
    });
    const rows = [];
    let i = 0;
    while (i < diff.length) {
      if (keep.has(i)) {
        rows.push(diff[i]);
        i++;
        continue;
      }
      let j = i;
      while (j < diff.length && !keep.has(j)) j++;
      rows.push({ type: "gap", text: "", skipped: j - i });
      i = j;
    }
    return rows;
  }
  function commonVersionLines(texts) {
    if (texts.length === 0) return [];
    const perText = texts.map((text) => {
      const counts = /* @__PURE__ */ new Map();
      for (const line of splitLines(text)) counts.set(line, (counts.get(line) ?? 0) + 1);
      return counts;
    });
    const out = [];
    const used = /* @__PURE__ */ new Map();
    for (const line of splitLines(texts[0])) {
      const seen = (used.get(line) ?? 0) + 1;
      used.set(line, seen);
      let min = Number.POSITIVE_INFINITY;
      for (const counts of perText) min = Math.min(min, counts.get(line) ?? 0);
      if (seen <= min && line.trim()) out.push(line);
    }
    return out;
  }
  function finalizeVersion(version) {
    const added = version.diff?.filter((line) => line.type === "add").length ?? 0;
    const removed = version.diff?.filter((line) => line.type === "del").length ?? 0;
    return { ...version, addedLines: added, removedLines: removed };
  }
  function foldContextVersions(records) {
    const order = [];
    const byKind = /* @__PURE__ */ new Map();
    for (const record of records) {
      const kind = record.kind || "unknown";
      const list = byKind.get(kind);
      if (list) {
        list.push(record);
      } else {
        byKind.set(kind, [record]);
        order.push(kind);
      }
    }
    const groups = order.map((kind) => {
      const list = byKind.get(kind) ?? [];
      const versions = [];
      for (const record of list) {
        const text = normalizeContextText(record.text);
        const last = versions[versions.length - 1];
        if (last && last.text === text) {
          last.occurrences += 1;
          if (record.timestampMs !== null) last.lastTs = record.timestampMs;
          continue;
        }
        const earlier = versions.find((candidate) => candidate.text === text);
        versions.push(
          finalizeVersion({
            index: versions.length + 1,
            text,
            occurrences: 1,
            firstTs: record.timestampMs,
            lastTs: record.timestampMs,
            addedLines: 0,
            removedLines: 0,
            diff: last ? diffContextLines(last.text, text) : null,
            repeatOf: earlier ? earlier.index : null
          })
        );
      }
      const commonLines = versions.length > 1 ? commonVersionLines(versions.map((v) => v.text)) : [];
      return {
        kind,
        records: list.length,
        versions,
        commonLines,
        changedVersions: versions.filter((v) => v.addedLines + v.removedLines > 0).length
      };
    });
    return {
      groups,
      totalRecords: records.length,
      totalVersions: groups.reduce((sum, group) => sum + group.versions.length, 0)
    };
  }

  // frontend/src/lib/markdown.ts
  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function renderMarkdownInline(s) {
    s = s.replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    return s;
  }
  function renderMarkdownBlock(segment) {
    const lines = segment.split("\n");
    const out = [];
    let para = [];
    let list = null;
    const flushPara = () => {
      const text = para.join("\n").replace(/^\n+|\n+$/g, "");
      if (text.trim()) out.push(`<p>${renderMarkdownInline(text).replace(/\n/g, "<br>")}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.type}>${list.items.join("")}</${list.type}>`);
      list = null;
    };
    for (const line of lines) {
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
      if (h) {
        flushPara();
        flushList();
        out.push(`<h${h[1].length}>${renderMarkdownInline(h[2])}</h${h[1].length}>`);
      } else if (ul) {
        flushPara();
        if (list?.type !== "ul") {
          flushList();
          list = { type: "ul", items: [] };
        }
        list.items.push(`<li>${renderMarkdownInline(ul[1])}</li>`);
      } else if (ol) {
        flushPara();
        if (list?.type !== "ol") {
          flushList();
          list = { type: "ol", items: [] };
        }
        list.items.push(`<li>${renderMarkdownInline(ol[1])}</li>`);
      } else if (!line.trim()) {
        flushPara();
        flushList();
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
    return out.join("");
  }
  function renderMarkdownHtml(text) {
    const escaped = escapeHtml(text);
    const segments = escaped.split(/```/);
    return segments.map((segment, index) => {
      if (index % 2 === 1) {
        const lines = segment.split("\n");
        const maybeLang = lines[0].trim();
        const code = lines.slice(1).join("\n") || lines.join("\n");
        return `<pre><code data-lang="${escapeHtml(maybeLang)}">${code}</code></pre>`;
      }
      return renderMarkdownBlock(segment);
    }).join("");
  }
  function renderMarkdown(text) {
    return `<div class="markdown">${renderMarkdownHtml(text)}</div>`;
  }

  // frontend/src/lib/pure.ts
  function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
  }
  function parseTimestampMs(value) {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  function formatDurationCompact(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return "0s";
    const totalSeconds = durationMs / 1e3;
    if (totalSeconds < 10) {
      return `${Math.round(totalSeconds * 10) / 10}s`;
    }
    const roundedSeconds = Math.round(totalSeconds);
    const hours = Math.floor(roundedSeconds / 3600);
    const minutes = Math.floor(roundedSeconds % 3600 / 60);
    const seconds = roundedSeconds % 60;
    if (hours > 0) {
      return `${hours}h${minutes ? `${minutes}m` : ""}${!minutes && seconds ? `${seconds}s` : ""}`;
    }
    if (minutes > 0) {
      return `${minutes}m${seconds ? `${seconds}s` : ""}`;
    }
    return `${seconds}s`;
  }
  function formatCost(dollars) {
    return `$${dollars >= 0.01 ? dollars.toFixed(2) : dollars.toFixed(4)}`;
  }
  function pickAutoPlatform(counts, order) {
    if (!counts) return null;
    for (const p of order) {
      if ((counts[p] ?? 0) > 0) return p;
    }
    return null;
  }
  function firstInformativeLine(text) {
    const joined = String(text || "");
    for (const rawLine of joined.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^[{}[\]()`"',;:.\-=|\\/*+\s]+$/.test(line)) continue;
      return line.slice(0, 200);
    }
    return joined.trim().replace(/\s+/g, " ").slice(0, 200);
  }
  function getTextContent(content) {
    return (content || []).filter((item) => item.type === "text").map((item) => item.text || "").join("\n\n");
  }
  function clusterPrefillContent(c) {
    const examples = (c.samples || c.examples || []).map((s) => String(s || "")).filter(Boolean);
    if (!examples.length) return c.pattern || "";
    let prefix = examples[0];
    for (const ex of examples.slice(1)) {
      let i = 0;
      while (i < prefix.length && i < ex.length && prefix[i] === ex[i]) i++;
      prefix = prefix.slice(0, i);
    }
    if (examples.length > 1 && prefix.trim().length >= 30 && prefix.length < examples[0].length) {
      return `${prefix.replace(/\s+$/, "")} $ARGUMENTS`;
    }
    return examples[0];
  }
  var TOOL_SUBJECT_FIELDS = [
    // Shell / command
    "command",
    "cmd",
    "code",
    "script",
    "shell",
    "bash",
    // File paths
    "file_path",
    "path",
    "file",
    "filename",
    "file_name",
    "source",
    "target",
    "destination",
    // Search / query
    "pattern",
    "query",
    "search",
    "keyword",
    "keywords",
    "regex",
    // URL / web
    "url",
    "uri",
    "endpoint",
    "link",
    // Generic
    "skill",
    "subject",
    "description",
    "prompt",
    "name",
    "title",
    "input",
    "content",
    "text",
    // Database
    "sql",
    "database",
    "db",
    "table",
    // Git
    "branch",
    "commit",
    "message"
  ];
  var TOOL_SUBJECT_MAX_CHARS = 80;
  function extractToolSubject(args) {
    if (args == null) return "";
    let raw = "";
    if (typeof args === "string") {
      raw = args;
    } else if (typeof args === "object") {
      const o = args;
      const pick = TOOL_SUBJECT_FIELDS.map((k) => o[k]).find(
        (v) => typeof v === "string" && v.trim().length > 0 || Array.isArray(v)
      );
      if (pick === void 0) return "";
      raw = Array.isArray(pick) ? String(pick[pick.length - 1] ?? "").trim() : String(pick).trim();
    }
    if (!raw) return "";
    if (raw.startsWith("{") && raw.length > 200) {
      for (const key of TOOL_SUBJECT_FIELDS) {
        const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
        if (m) {
          try {
            const v = JSON.parse(`"${m[1]}"`);
            if (typeof v === "string" && v.trim()) raw = v.trim();
            break;
          } catch {
          }
        }
      }
    }
    const collapsed = raw.replace(/\s+/g, " ").trim();
    if (!collapsed) return "";
    return collapsed.length > TOOL_SUBJECT_MAX_CHARS ? `${collapsed.slice(0, TOOL_SUBJECT_MAX_CHARS)}…` : collapsed;
  }
  function buildTraceTurns(msgs, agentSpans = []) {
    const ts = (m) => parseTimestampMs(m.timestamp);
    const calls = /* @__PURE__ */ new Map();
    const results = /* @__PURE__ */ new Map();
    for (const m of msgs) {
      const t = ts(m);
      if (m.role === "toolCall" && m.toolCallId)
        calls.set(m.toolCallId, {
          name: m.toolName || "?",
          ts: t,
          msgId: m.id,
          estimatedDurationMs: typeof m.details?.estimatedDurationMs === "number" && m.details.estimatedDurationMs > 0 ? m.details.estimatedDurationMs : null,
          args: m.details ?? null
        });
      if (m.role === "toolResult" && m.toolCallId) results.set(m.toolCallId, { ts: t, isError: !!m.isError });
      for (const c of m.content || []) {
        if ((c.type === "toolCall" || c.type === "tool_use") && c.id)
          calls.set(c.id, {
            name: c.name || "?",
            ts: t,
            msgId: m.id,
            estimatedDurationMs: typeof c.estimatedDurationMs === "number" && c.estimatedDurationMs > 0 ? c.estimatedDurationMs : null,
            args: c.arguments ?? c.input ?? null
          });
        if (c.type === "tool_result" && c.tool_use_id) results.set(c.tool_use_id, { ts: t, isError: !!c.is_error });
      }
    }
    const turns = [];
    let turn = null;
    let prevTs = null;
    for (const m of msgs) {
      const t = ts(m);
      if (!t) continue;
      if (m.role === "user") {
        const text = getTextContent(m.content || []).replace(/\s+/g, " ").trim();
        turn = { start: t, end: t, text: text.slice(0, 140) || "(user)", spans: [] };
        turns.push(turn);
        prevTs = t;
        continue;
      }
      if (!turn) {
        turn = { start: t, end: t, text: "(session start)", spans: [] };
        turns.push(turn);
        prevTs = t;
      }
      if (m.role === "assistant" && prevTs && t > prevTs) {
        const chatText = getTextContent(m.content || []);
        const u = m.usage || {};
        const inputTokens = num(u.input) || num(u.input_tokens);
        const outputTokens = num(u.output) || num(u.output_tokens);
        const cacheReadTokens = num(u.cacheRead) || num(u.cache_read);
        const cacheWriteTokens = num(u.cacheWrite) || num(u.cache_write);
        const reasoningTokens = num(u.reasoning) || num(u.reasoning_tokens);
        const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens;
        const span = {
          kind: "chat",
          label: (m.model || "model").split("/").pop(),
          start: prevTs,
          end: t,
          msgId: m.id,
          hasText: chatText.trim().length > 0
        };
        if (totalTokens > 0) {
          span.inputTokens = inputTokens || void 0;
          span.outputTokens = outputTokens || void 0;
          span.cacheReadTokens = cacheReadTokens || void 0;
          span.cacheWriteTokens = cacheWriteTokens || void 0;
          span.reasoningTokens = reasoningTokens || void 0;
          span.totalTokens = totalTokens;
        }
        turn.spans.push(span);
      }
      if (m.role !== "reasoning") prevTs = t;
      turn.end = Math.max(turn.end, t);
    }
    turns.sort((a, b) => a.start - b.start);
    for (const [cid, c] of calls) {
      if (!c.ts) continue;
      const r = results.get(cid);
      const measured = Boolean(r?.ts && r.ts > c.ts);
      const estimated = !measured && c.estimatedDurationMs != null;
      const end = measured ? r?.ts : c.ts + (c.estimatedDurationMs || 50);
      let owner = null;
      for (const tn of turns) {
        if (tn.start <= c.ts) owner = tn;
        else break;
      }
      if (!owner) continue;
      owner.spans.push({
        kind: r?.isError ? "tool-error" : "tool",
        label: c.name,
        start: c.ts,
        end,
        durationSource: measured ? "measured" : estimated ? "estimated" : "unknown",
        msgId: c.msgId,
        toolCallId: cid,
        subject: extractToolSubject(c.args)
      });
      owner.end = Math.max(owner.end, end);
    }
    for (const a of agentSpans) {
      if (!a.start) continue;
      const end = a.end && a.end > a.start ? a.end : a.start + 50;
      let owner = null;
      for (const tn of turns) {
        if (tn.start <= a.start) owner = tn;
        else break;
      }
      if (!owner) continue;
      owner.spans.push({ kind: "agent", label: a.label || a.name, start: a.start, end, agentName: a.name });
      owner.end = Math.max(owner.end, end);
    }
    const SPAN_KIND_ORDER = {
      chat: 0,
      agent: 1,
      tool: 2,
      "tool-error": 3
    };
    for (const tn of turns) {
      tn.spans.sort((a, b) => {
        if (a.start !== b.start) return a.start - b.start;
        const ko = SPAN_KIND_ORDER[a.kind] - SPAN_KIND_ORDER[b.kind];
        if (ko !== 0) return ko;
        return a.label.localeCompare(b.label);
      });
      let lastTextChat = null;
      for (const s of tn.spans) {
        if (s.kind === "chat" && s.hasText) lastTextChat = s;
      }
      if (lastTextChat) lastTextChat.isFinalReply = true;
      tn.spans = treeifySpans(tn.spans);
    }
    return turns.filter((tn) => tn.spans.length > 0);
  }
  function treeifySpans(spans) {
    const chatByMsgId = /* @__PURE__ */ new Map();
    const roots = [];
    let lastChat = null;
    for (const s of spans) {
      if (s.kind === "chat") {
        s.children = [];
        s.depth = 0;
        if (s.msgId) chatByMsgId.set(s.msgId, s);
        lastChat = s;
        roots.push(s);
      }
    }
    for (const s of spans) {
      if (s.kind === "chat") continue;
      const parent = s.msgId && chatByMsgId.get(s.msgId) || lastChat;
      if (parent) {
        s.depth = 1;
        parent.children?.push(s);
      } else {
        s.depth = 0;
        roots.push(s);
      }
    }
    for (const r of roots) {
      if (r.children) r.children.sort((a, b) => a.start - b.start);
    }
    return roots;
  }
  function flattenSpans(spans) {
    const out = [];
    for (const s of spans) {
      out.push(s);
      if (s.children && s.children.length > 0) out.push(...flattenSpans(s.children));
    }
    return out;
  }
  function parseToolArguments(args) {
    if (args == null) return { object: null, text: "", wasJsonString: false };
    if (typeof args === "string") {
      const trimmed = args.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed !== null && typeof parsed === "object") {
            return {
              object: parsed,
              text: JSON.stringify(parsed, null, 2),
              wasJsonString: true
            };
          }
          return { object: null, text: String(parsed), wasJsonString: true };
        } catch {
          return { object: null, text: args, wasJsonString: false };
        }
      }
      return { object: null, text: "", wasJsonString: false };
    }
    if (typeof args === "object") {
      return { object: args, text: JSON.stringify(args, null, 2), wasJsonString: false };
    }
    return { object: null, text: String(args), wasJsonString: false };
  }
  var PATCH_FILE_MARKERS = ["*** Begin Patch", "*** Update File:", "*** Add File:", "*** Delete File:", "diff --git "];
  function detectPatch(text) {
    if (!text) return false;
    const lines = text.split("\n");
    const hasFileHeader = lines.some((l) => PATCH_FILE_MARKERS.some((m) => l.includes(m)));
    const hasHunk = lines.some((l) => l.startsWith("@@"));
    const hasChange = lines.some((l) => l.startsWith("+") || l.startsWith("-"));
    return hasFileHeader && (hasHunk || hasChange);
  }
  function extractEmbeddedPatch(text) {
    if (!text) return null;
    if (!text.includes("*** ") && !text.includes("diff --git") && !text.includes("@@")) return null;
    const re = /"((?:[^"\\]|\\.)*)"/g;
    let m;
    while (m = re.exec(text)) {
      const body = m[1];
      if (!body.includes("*** ") && !body.includes("diff --git") && !body.includes("@@")) continue;
      try {
        const decoded = JSON.parse(`"${body}"`);
        if (typeof decoded === "string" && decoded.length > 10 && detectPatch(decoded)) return decoded;
      } catch {
      }
    }
    return null;
  }
  function diffLineSegments(text) {
    const lines = text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines.map((line) => {
      if (line.startsWith("*** ") || line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index "))
        return { type: "file", text: line };
      if (line.startsWith("@@")) return { type: "hunk", text: line };
      if (line.startsWith("+")) return { type: "add", text: line };
      if (line.startsWith("-")) return { type: "del", text: line };
      return { type: "context", text: line };
    });
  }
  return __toCommonJS(legacy_pure_exports);
})();

(function (root, api) {
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    for (var key in api) root[key] = api[key];
  }
})(typeof window !== 'undefined' ? window : globalThis, __axrPure);
