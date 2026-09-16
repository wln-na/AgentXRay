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
    escapeHtml: () => escapeHtml,
    firstInformativeLine: () => firstInformativeLine,
    flattenSpans: () => flattenSpans,
    formatBytes: () => formatBytes,
    formatCost: () => formatCost,
    formatDurationCompact: () => formatDurationCompact,
    getTextContent: () => getTextContent,
    parseTimestampMs: () => parseTimestampMs,
    pickAutoPlatform: () => pickAutoPlatform,
    renderMarkdown: () => renderMarkdown,
    renderMarkdownHtml: () => renderMarkdownHtml
  });

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
    return "$" + (dollars >= 0.01 ? dollars.toFixed(2) : dollars.toFixed(4));
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
      return prefix.replace(/\s+$/, "") + " $ARGUMENTS";
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
      const pick = TOOL_SUBJECT_FIELDS.map((k) => o[k]).find((v) => typeof v === "string" && v.trim().length > 0 || Array.isArray(v));
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
        kind: r && r.isError ? "tool-error" : "tool",
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
        parent.children.push(s);
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
        if (!list || list.type !== "ul") {
          flushList();
          list = { type: "ul", items: [] };
        }
        list.items.push(`<li>${renderMarkdownInline(ul[1])}</li>`);
      } else if (ol) {
        flushPara();
        if (!list || list.type !== "ol") {
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
  return __toCommonJS(legacy_pure_exports);
})();

(function (root, api) {
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    for (var key in api) root[key] = api[key];
  }
})(typeof window !== 'undefined' ? window : globalThis, __axrPure);
