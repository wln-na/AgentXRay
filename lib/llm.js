const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { HOME } = require('./config');

// LLM backend abstraction. Configuration is local to the machine running
// AgentXRay and supports multiple named profiles plus per-feature routing.
// Every LLM-backed feature goes through runLlm(input, timeout, { purpose }).

const LLM_CONFIG_FILE = path.join(HOME, '.agentxray', 'llm.json');
// Test seam: point at a nonexistent binary to simulate a machine without claude.
const CLAUDE_BIN = process.env.AGENTXRAY_CLAUDE_BIN || 'claude';
const PROFILE_TYPES = new Set(['openai-compatible', 'claude-cli']);

const EMPTY_CONFIG = {
  version: 2,
  activeProfile: '',
  profiles: {},
  routes: {},
};

function cleanProfile(raw) {
  const type = raw?.type === 'claude-cli' || raw?.kind === 'claude-cli' ? 'claude-cli' : 'openai-compatible';
  if (type === 'claude-cli') return { type, baseUrl: '', apiKey: '', model: '' };
  return {
    type,
    baseUrl: typeof raw?.baseUrl === 'string' ? raw.baseUrl.trim() : '',
    apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey : '',
    model: typeof raw?.model === 'string' ? raw.model.trim() : '',
  };
}

function normalizeLlmConfig(parsed) {
  if (parsed?.profiles && typeof parsed.profiles === 'object' && !Array.isArray(parsed.profiles)) {
    const profiles = {};
    for (const [name, raw] of Object.entries(parsed.profiles)) {
      if (typeof name !== 'string' || !raw || typeof raw !== 'object') continue;
      profiles[name] = cleanProfile(raw);
    }
    const activeProfile = typeof parsed.activeProfile === 'string' ? parsed.activeProfile.trim() : '';
    const routes = {};
    if (parsed.routes && typeof parsed.routes === 'object' && !Array.isArray(parsed.routes)) {
      for (const [purpose, target] of Object.entries(parsed.routes)) {
        if (typeof target === 'string' && target.trim()) routes[purpose] = target.trim();
      }
    }
    return { version: 2, activeProfile, profiles, routes };
  }

  // Migrate the original single-endpoint format in memory. The file is
  // rewritten in the new shape on the next save.
  if (parsed && (parsed.baseUrl || parsed.model || parsed.apiKey)) {
    return {
      version: 2,
      activeProfile: 'default',
      profiles: { default: cleanProfile(parsed) },
      routes: {},
    };
  }
  return { ...EMPTY_CONFIG, profiles: {}, routes: {} };
}

async function loadLlmConfig() {
  try {
    return normalizeLlmConfig(JSON.parse(await fsp.readFile(LLM_CONFIG_FILE, 'utf8')));
  } catch {
    return { ...EMPTY_CONFIG, profiles: {}, routes: {} };
  }
}

function serializableConfig(config) {
  const normalized = normalizeLlmConfig(config);
  return {
    version: 2,
    activeProfile: normalized.activeProfile,
    profiles: Object.fromEntries(
      Object.entries(normalized.profiles).map(([name, profile]) => [name, cleanProfile(profile)])
    ),
    routes: { ...normalized.routes },
  };
}

// Atomic write: tmp file + rename so a crash never truncates the store.
async function saveLlmConfig(config) {
  const next = serializableConfig(config);
  await fsp.mkdir(path.dirname(LLM_CONFIG_FILE), { recursive: true });
  const tmpPath = `${LLM_CONFIG_FILE}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fsp.rename(tmpPath, LLM_CONFIG_FILE);
  return next;
}

// Cheap PATH scan (no subprocess): is a claude CLI available?
function findClaudeCli() {
  if (path.isAbsolute(CLAUDE_BIN)) {
    try {
      fs.accessSync(CLAUDE_BIN, fs.constants.X_OK);
      return CLAUDE_BIN;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, CLAUDE_BIN);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

function runClaudeCli(input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = execFile(CLAUDE_BIN, ['-p'], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function runOpenAi(config, input, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: input }] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`LLM 端点返回 ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text) {
      throw new Error('LLM 端点响应缺少 choices[0].message.content');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function isUsableProfile(profile) {
  return profile?.type === 'claude-cli' || (profile?.type === 'openai-compatible' && profile.baseUrl && profile.model);
}

function selectedTarget(config, purpose) {
  return config.routes?.[purpose] || config.activeProfile || null;
}

function resolveBackend(config, purpose) {
  const target = selectedTarget(config, purpose);
  if (target === 'claude-cli') {
    return { kind: 'claude-cli', profileName: 'claude-cli', profile: { type: 'claude-cli' } };
  }
  if (target) {
    const profile = config.profiles?.[target];
    if (!profile) {
      const error = new Error(`LLM profile not found: ${target}`);
      error.code = 'LLM_PROFILE_NOT_FOUND';
      throw error;
    }
    if (!isUsableProfile(profile)) {
      const error = new Error(`LLM profile is incomplete: ${target}`);
      error.code = 'LLM_PROFILE_INVALID';
      throw error;
    }
    return {
      kind: profile.type === 'claude-cli' ? 'claude-cli' : 'openai',
      profileName: target,
      profile,
    };
  }
  if (findClaudeCli()) {
    return { kind: 'claude-cli', profileName: 'claude-cli', profile: { type: 'claude-cli' } };
  }
  return null;
}

// Which backend a purpose would use right now.
async function llmBackend(options = {}) {
  try {
    const config = await loadLlmConfig();
    return resolveBackend(config, options.purpose || 'default')?.kind || null;
  } catch {
    return null;
  }
}

async function runLlm(input, timeoutMs, options = {}) {
  const config = await loadLlmConfig();
  const backend = resolveBackend(config, options.purpose || 'default');
  if (backend?.kind === 'openai') return runOpenAi(backend.profile, input, timeoutMs);
  if (backend?.kind === 'claude-cli') return runClaudeCli(input, timeoutMs);
  const err = new Error(
    '未配置 LLM 后端：请在 设置 → LLM 接口 中配置一个 profile，或安装并登录 claude CLI（npm i -g @anthropic-ai/claude-code）。'
  );
  err.code = 'NO_LLM_BACKEND';
  throw err;
}

module.exports = {
  LLM_CONFIG_FILE,
  PROFILE_TYPES,
  loadLlmConfig,
  normalizeLlmConfig,
  saveLlmConfig,
  findClaudeCli,
  llmBackend,
  resolveBackend,
  runLlm,
};
