// --- Session stats computed server-side from normalized messages ---
// Ported from frontend/src/views/sessions/lib.ts computeSessionStats so the
// session detail API can ship precomputed stats and the client can skip the
// O(n) scan for large sessions. The client falls back to its own copy when
// the backend field is absent (older deployments / cached responses).

/** Detect exec/claude spawn tool calls (mirrors frontend isSpawnPart). */
function isSpawnPart(c) {
  if (c.type !== 'toolCall') return false;
  if (c.name === 'sessions_spawn' || c.name === 'delegate_task') return true;
  if (c.name === 'exec') {
    const command = c.arguments && typeof c.arguments === 'object' ? c.arguments.command : undefined;
    if (typeof command === 'string') {
      const cmd = command.toLowerCase();
      return cmd.includes('codex ') || cmd.includes('claude ');
    }
  }
  return false;
}

/** Extract skill names referenced via SKILL.md paths in tool-call arguments. */
function skillNamesFromValue(value) {
  const names = new Set();
  const skillPathPattern = /(?:^|[\\/])([^\\/"'\s<>$]+)[\\/]SKILL\.md\b/gi;
  const addPathMatches = (text) => {
    for (const match of text.matchAll(skillPathPattern)) {
      const name = match[1];
      if (name && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) names.add(name);
    }
  };
  const stripHeredocs = (command) =>
    command.replace(/<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*\n[\s\S]*?\n\1(?=\n|$)/g, '');
  const scanCommand = (rawCommand) => {
    let command = stripHeredocs(rawCommand);
    command = command.replace(
      /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]+);\s*do([\s\S]*?)\bdone\b/g,
      (whole, variable, rawItems, body) => {
        const variablePath = new RegExp(`\\$\\{?${variable}\\}?[\\\\/]SKILL\\.md\\b`);
        const readsSkill = /\b(?:cat|sed|head|tail|less|more|bat|batcat|nl|awk|grep|rg)\b/.test(body);
        if (readsSkill && variablePath.test(body)) {
          for (const item of rawItems.trim().split(/\s+/)) {
            const name = item.replace(/^['"]|['"]$/g, '');
            if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) names.add(name);
          }
        }
        return whole.replace(body, '');
      }
    );
    for (const segment of command.split(/(?:\n|;|&&|\|\|)/)) {
      if (!/\b(?:cat|sed|head|tail|less|more|bat|batcat|nl|awk|grep|rg)\b/.test(segment)) continue;
      addPathMatches(segment);
    }
  };
  const scan = (candidate, key = '') => {
    if (typeof candidate === 'string') {
      if (key === 'cmd' || key === 'command') {
        scanCommand(candidate);
        return;
      }
      if (['path', 'file_path', 'filename', 'notebook_path'].includes(key)) {
        addPathMatches(candidate);
        return;
      }
      if (key === '' || key === 'arguments' || key === 'input' || key === 'details') {
        try {
          scan(JSON.parse(candidate), key);
        } catch {
          // Unstructured prose is not evidence of a Skill read.
        }
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) scan(item, key);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [childKey, childValue] of Object.entries(candidate)) scan(childValue, childKey);
  };
  scan(value);
  return [...names];
}

/** Extract skill *file* reads (paths under .skills/ or skills-archive/). */
function skillFileNamesFromValue(value) {
  const names = new Set();
  const skillFilePattern = /(?:^|[\\/])(?:\.?skills|skills-archive)[\\/]([^\\/"'\s<>$]+)[\\/]([^"'\s<>$]+)/gi;
  const addPathMatches = (text) => {
    for (const match of text.matchAll(skillFilePattern)) {
      const name = match[1];
      const relativePath = match[2] || '';
      if (name && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !/^SKILL\.md(?:\b|$)/i.test(relativePath)) {
        names.add(name);
      }
    }
  };
  const stripHeredocs = (command) =>
    command.replace(/<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*\n[\s\S]*?\n\1(?=\n|$)/g, '');
  const scan = (candidate, key = '') => {
    if (typeof candidate === 'string') {
      if (key === 'cmd' || key === 'command') {
        const command = stripHeredocs(candidate);
        for (const segment of command.split(/(?:\n|;|&&|\|\|)/)) {
          if (!/\b(?:cat|sed|head|tail|less|more|bat|batcat|nl|awk|grep|rg)\b/.test(segment)) continue;
          addPathMatches(segment);
        }
      } else if (['path', 'file_path', 'filename', 'notebook_path', 'pattern'].includes(key)) {
        addPathMatches(candidate);
      } else if (key === '' || key === 'arguments' || key === 'input' || key === 'details') {
        try {
          scan(JSON.parse(candidate), key);
        } catch {
          // Unstructured prose is not evidence of a Skill file read.
        }
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) scan(item, key);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [childKey, childValue] of Object.entries(candidate)) scan(childValue, childKey);
  };
  scan(value);
  return [...names];
}

/** Combine skill loads + file reads for a single tool call. */
function skillUsageFromToolCall(toolName, value) {
  const loads = new Set(skillNamesFromValue(value));
  const fileReads = new Set(skillFileNamesFromValue(value));
  const normalizedTool = String(toolName || '').toLowerCase();

  if (normalizedTool === 'skill') {
    const record = value && typeof value === 'object' ? value : null;
    const args =
      record && record.arguments && typeof record.arguments === 'object'
        ? record.arguments
        : record && record.input && typeof record.input === 'object'
          ? record.input
          : record;
    for (const key of ['skill', 'command', 'skill_name', 'name']) {
      const candidate = args ? args[key] : undefined;
      if (typeof candidate !== 'string') continue;
      const raw = candidate.trim().replace(/^\/+/, '').split(/\s+/)[0] || '';
      const name = raw.split(':').at(-1) || '';
      if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) loads.add(name);
    }
  }
  return { loads: [...loads], fileReads: [...fileReads] };
}

/** Extract MCP server name from a tool name like mcp__server__tool. */
function mcpServerFromToolName(toolName) {
  const raw = String(toolName || '');
  if (!raw.startsWith('mcp__')) return null;
  return raw.slice('mcp__'.length).split('__')[0] || null;
}

/**
 * Compute per-session stats from a normalized message array.
 * Mirrors frontend computeSessionStats (views/sessions/lib.ts).
 *
 * @param {Array} msgs - normalized SessionMessage[]
 * @returns {{userCount, assistantCount, toolCallCount, toolResultCount, errorCount, spawnCount, toolNames, skillNames, skillFileReads, mcpServers, totalRetryTools, totalRetryAttempts}}
 */
function computeSessionStats(msgs) {
  const stats = {
    userCount: 0,
    assistantCount: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    errorCount: 0,
    spawnCount: 0,
    toolNames: {},
    skillNames: {},
    skillFileReads: {},
    mcpServers: {},
    totalRetryTools: 0,
    totalRetryAttempts: 0,
  };
  let turnToolErrors = {};
  for (const msg of msgs) {
    if (msg.role === 'user') {
      turnToolErrors = {};
      stats.userCount++;
    }
    if (msg.role === 'assistant') stats.assistantCount++;
    if (msg.role === 'toolResult') {
      stats.toolResultCount++;
      const name = msg.toolName || msg.name || '?';
      if (msg.isError) {
        stats.errorCount++;
        turnToolErrors[name] = (turnToolErrors[name] || 0) + 1;
      } else if (turnToolErrors[name] > 0) {
        stats.totalRetryTools++;
        stats.totalRetryAttempts += turnToolErrors[name];
        turnToolErrors[name] = 0;
      }
    }
    if (msg.role === 'toolCall') {
      stats.toolCallCount++;
      const name = msg.toolName || 'unknown';
      stats.toolNames[name] = (stats.toolNames[name] || 0) + 1;
      const usage = skillUsageFromToolCall(msg.toolName, msg.details);
      for (const skill of usage.loads) stats.skillNames[skill] = (stats.skillNames[skill] || 0) + 1;
      for (const skill of usage.fileReads) stats.skillFileReads[skill] = (stats.skillFileReads[skill] || 0) + 1;
      const server = mcpServerFromToolName(name);
      if (server) stats.mcpServers[server] = (stats.mcpServers[server] || 0) + 1;
    }
    for (const c of msg.content || []) {
      if (c.type === 'toolCall') {
        stats.toolCallCount++;
        const name = c.name || 'unknown';
        stats.toolNames[name] = (stats.toolNames[name] || 0) + 1;
        const usage = skillUsageFromToolCall(c.name, c);
        for (const skill of usage.loads) stats.skillNames[skill] = (stats.skillNames[skill] || 0) + 1;
        for (const skill of usage.fileReads) stats.skillFileReads[skill] = (stats.skillFileReads[skill] || 0) + 1;
        const server = mcpServerFromToolName(name);
        if (server) stats.mcpServers[server] = (stats.mcpServers[server] || 0) + 1;
        if (isSpawnPart(c)) stats.spawnCount++;
      }
    }
  }
  return stats;
}

module.exports = {
  computeSessionStats,
};
